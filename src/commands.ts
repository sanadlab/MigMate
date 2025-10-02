import * as vscode from 'vscode';
import { migrationState, MigrationChange } from './services/migrationState';
import { configService } from './services/config';
import { getLibrariesFromRequirements, getSourceLibrary, getTargetLibrary } from './services/librariesApi';
import { runCliTool, buildCliCommand } from './services/cli';
import { exec, execSync } from 'child_process';
import { telemetryService } from './services/telemetry';
import { codeLensProvider, InlineDiffProvider } from './providers';
import { checkTestResults, showTestResultsDetail } from './services/testResults';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';



export function registerCommands(context: vscode.ExtensionContext) {
    const inlineDiffProvider = new InlineDiffProvider();



	// // Perform a library migration
	const migrateCommand = vscode.commands.registerCommand('libmig.migrate', async (hoverLibrary?: string) => {
		console.log('Beginning migration...');
		telemetryService.sendTelemetryEvent('migrationStarted', { trigger: hoverLibrary ? 'hover' : 'commandPalette' }); // check this for context menu

		try {
			// // Run from open directory instead of VS Code installation path
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders || workspaceFolders.length === 0) {
				vscode.window.showErrorMessage('No workspace folder is open. Please open a project to run this command.');
				return;
			}
			const cwd = workspaceFolders[0].uri.fsPath;
			console.log("Directory:", cwd);

			// // Read requirements file to produce a list of source libraries
			const libraries = await getLibrariesFromRequirements();
			if (libraries.length <= 0) {
				vscode.window.showWarningMessage('No libraries found in requirements file.');
			}

			// // Get the source & target libraries
			const srcLib = await getSourceLibrary(hoverLibrary, libraries);
			if (!srcLib) {
				vscode.window.showInformationMessage('Migration cancelled: No source library selected.');
				telemetryService.sendTelemetryEvent('migrationCancelled', { reason: 'noSourceLibrary' });
				return;
			}
			const tgtLib = await getTargetLibrary(srcLib);
			if (!tgtLib) {
				vscode.window.showInformationMessage('Migration cancelled: No target library selected.');
				telemetryService.sendTelemetryEvent('migrationCancelled', { reason: 'noTargetLibrary' });
				return;
			}

			// // Check this
			const editor = vscode.window.activeTextEditor;
			if (!editor) {return;}

			// // Keep the mock version for now
			const useMockChanges = false;
			let changes: Omit<MigrationChange, 'hunks'>[] = [];

			// // Perform the migration
			vscode.window.showInformationMessage(`Migrating from library '${srcLib}' to library '${tgtLib}'...`);
			console.log(`Migration initiated from '${srcLib}' to '${tgtLib}'`);
			telemetryService.sendTelemetryEvent('migrationBegun', { source: srcLib, target: tgtLib });

			if (useMockChanges) {
				const originalContent = editor.document.getText();
				let updatedContent = originalContent;
				updatedContent = updatedContent.replace("import requests", "import httpx");
				const multiOriginal = `    resp = requests.get(\n        "https://api.example.com/data",\n        params={"q": "test", "limit": 5}\n    )`;
				const multiUpdated = `    resp = httpx.get(\n        "https://api.example.com/data2",\n        params={"q": "test", "limit": 3}\n    )`;
				updatedContent = updatedContent.replace(multiOriginal, multiUpdated);
				updatedContent = updatedContent.replace("with requests.Session() as session:", "with httpx.Client() as session:");

				changes = [{
					uri: editor.document.uri,
					originalContent: originalContent,
					updatedContent: updatedContent,
				}];
			}
			else {
				// // Create a temporary directory for the migrated files
                const tempDir = path.join(os.tmpdir(), `libmig-preview-${Date.now()}`);
				console.log("New Directory:", tempDir);
                fs.mkdirSync(tempDir, { recursive: true });

                try {
					// // Filter for relevant files, print the details for now to check
                    let pythonFiles = await vscode.workspace.findFiles(
						new vscode.RelativePattern(cwd, '**/*.py'),
						'{**/node_modules/**,**/.venv/**,**/venv/**,**/.git/**,**/site-packages/**,**/__pycache__/**,**/\\.pytest_cache/**,**/\\.tox/**,**/\\.mypy_cache/**}'
					);
					pythonFiles = pythonFiles.filter(file => !file.fsPath.endsWith('_run_tests_.py')); // figure out if this should be filtered before or after
					const requirementsFiles = await vscode.workspace.findFiles(new vscode.RelativePattern(cwd, '**/requirements.txt'));
                    console.log(`Found ${pythonFiles.length} Python files in workspace`);
					console.log("Found Python files in these locations:");
					pythonFiles.forEach(file => {
						console.log(file.fsPath);
					});

					// // Copy all of the files into the temp directory (WIP, but hopefully it can compare the migrated ones stored in temp)
					const allFilesToCopy = [...pythonFiles, ...requirementsFiles];
                    for (const fileUri of allFilesToCopy) {
                        const relativePath = path.relative(cwd, fileUri.fsPath);
                        const tempFilePath = path.join(tempDir, relativePath);
                        fs.mkdirSync(path.dirname(tempFilePath), { recursive: true });
                        const content = fs.readFileSync(fileUri.fsPath, 'utf8');
                        fs.writeFileSync(tempFilePath, content);
                    }

					// // Initialize a new git repo, should prevent the InvalidGitRepositoryError
					try {
                        execSync('git init', { cwd: tempDir });
                        execSync('git add .', { cwd: tempDir });
                        execSync('git commit -m "Initial state for migration"', { cwd: tempDir });
                    } catch (gitError) {
                        console.error('Failed to initialize git repository:', gitError);
                        vscode.window.showErrorMessage('Failed to initialize git for migration. Please ensure git is installed and in your PATH.');
                        fs.rmSync(tempDir, { recursive: true, force: true });
                        return;
                    }

                    // // Run CLI on temp dir (WIP) // check this
                    console.log(`Running migration command in temp directory: ${tempDir}`);
					const command = buildCliCommand(srcLib, tgtLib);
                    await runCliTool(command, tempDir);

					// // Check for test failures
					const testResults = await checkTestResults(tempDir);
					if (testResults.hasFailures) {
						const viewDetailsAction = 'View Details';
						const response = await vscode.window.showWarningMessage(
							`${testResults.failureCount} test${testResults.failureCount !== 1 ? 's' : ''} failed during migration.`,
							viewDetailsAction
						);
						if (response === viewDetailsAction) {
							showTestResultsDetail(testResults);
						}
					}

                    // // Compare the files here, diff the originals against migrated copies
                    const realChanges: Omit<MigrationChange, 'hunks'>[] = [];
                    for (const fileUri of pythonFiles) {

						if (fileUri.fsPath.endsWith('_run_tests_.py')) {continue;} // check this, maybe not necessary here

                        const relativePath = path.relative(cwd, fileUri.fsPath);
                        const tempFilePath = path.join(tempDir, relativePath);

                        if (!fs.existsSync(tempFilePath)) {
                            continue;
                        }

                        const originalContent = fs.readFileSync(fileUri.fsPath, 'utf8');
                        const updatedContent = fs.readFileSync(tempFilePath, 'utf8');
                        if (originalContent !== updatedContent) {
                            realChanges.push({
                                uri: fileUri,
                                originalContent,
                                updatedContent
                            });
                        }
                    }
                    changes = realChanges;
                    console.log(`Found ${changes.length} files with changes`);
                } catch (error) {
                    console.error('Error during temp directory migration:', error);
                    vscode.window.showErrorMessage('Error running migration in temporary directory.');
                } finally {
                //     try {
                //         fs.rmSync(tempDir, { recursive: true, force: true }); // temp stop cleanup
                //     } catch (cleanupError) {
                //         console.warn('Failed to clean up temp directory:', cleanupError);
                //     }

					context.workspaceState.update('lastMigrationTempDir', tempDir);
                }
            }
            if (changes.length === 0) {
                vscode.window.showInformationMessage('No changes were detected during migration.');
                return;
            }
			migrationState.loadChanges(changes);
			telemetryService.sendTelemetryEvent('migrationCompleted', { source: srcLib, target: tgtLib });


			// // Show preview based on mode selected in config
			const previewMode = configService.get<string>('flags.previewGrouping');
			console.log("Preview mode:", previewMode);
			if (previewMode === 'All at once') {
				telemetryService.sendTelemetryEvent('migrationPreview', { mode: 'grouped' });
				const edit = new vscode.WorkspaceEdit();
				const fileInfo = new Map<string, { eol: string; endsWithEol: boolean; lineCount: number }>();
				const loadedChanges = migrationState.getChanges();

				if (loadedChanges.length === 0) {
					vscode.window.showInformationMessage('No changes made during migration');
				}

				for (const change of loadedChanges) {
					// // Keep track of EOL/EOF characters for each file being changed
					const key = change.uri.toString();
					if (!fileInfo.has(key)) {
						const doc = await vscode.workspace.openTextDocument(change.uri);
						const eol = doc.eol === vscode.EndOfLine.LF ? '\n' : '\r\n';
						fileInfo.set(key, {eol, endsWithEol: doc.getText().endsWith(eol), lineCount: doc.lineCount});
					}
					const { eol, endsWithEol, lineCount } = fileInfo.get(key)!;

					// // Retrieve the hunks and sort the changes from bottom to top
					const hunks = migrationState.getHunks(change.uri);
					console.log(hunks);
					const processedHunkIds = new Set<number>();

					for (let i = 0; i < hunks.length; i++) {
						const currentHunk = hunks[i];
						if (processedHunkIds.has(currentHunk.id)) {continue;} // hopefully stops the changes from being unchecked by default

						// // Pair remove + added --> replacement
						if (currentHunk.type === 'removed' && i + 1 < hunks.length) {
							const nextHunk = hunks[i + 1];
							if (nextHunk.type === 'added' && nextHunk.originalStartLine === currentHunk.originalStartLine) {
								const startPos = new vscode.Position(currentHunk.originalStartLine, 0);
								const endPos = new vscode.Position(currentHunk.originalStartLine + currentHunk.lines.length, 0);
								const range = new vscode.Range(startPos, endPos);
								let newText = nextHunk.lines.join(eol);

								// // Respect original file's trailing EOL
								const afterLine = currentHunk.originalStartLine + currentHunk.lines.length;
								const reachedEOF = afterLine >= lineCount;
								if (reachedEOF) {
									if (endsWithEol && !newText.endsWith(eol)) {
										newText += eol;
									}
									else if (!endsWithEol && newText.endsWith(eol)) {
										newText = newText.replace(new RegExp(`${eol}$`), '');
									}
								}
								else {
									if (nextHunk.lines.length > 0 && !newText.endsWith(eol)) {
										newText += eol;
									}
								}

								const metadata: vscode.WorkspaceEditEntryMetadata = {
									label: `Replace '${migrationState.cleanString(currentHunk.lines[0]).substring(0, 15)}...' with '${migrationState.cleanString(nextHunk.lines[0]).substring(0, 15)}...'`,
									description: `Lines ${currentHunk.originalStartLine + 1} - ${currentHunk.originalStartLine + currentHunk.lines.length}`,
									needsConfirmation: true,
								};
								edit.replace(change.uri, range, newText, metadata);
								processedHunkIds.add(currentHunk.id);
                				processedHunkIds.add(nextHunk.id);
								continue;
							}
						}

						// // Standalone add/remove
						if (!processedHunkIds.has(currentHunk.id)) {
							console.log("Standalone hunk:", currentHunk);
							console.log("EOL character representation:", eol === '\n' ? "\\n" : "\\r\\n");
    						console.log("EOL length:", eol.length);
							migrationState.handleSingleHunk(edit, change.uri, currentHunk, eol);
						}
					}
				}

				await vscode.workspace.applyEdit(edit, { isRefactoring: true });
				migrationState.clear();
				codeLensProvider.refresh();
				inlineDiffProvider.clearDecorations(editor);
			}
			else { // consider removing this branch
				telemetryService.sendTelemetryEvent('migrationPreview', { mode: 'inline' });
				vscode.window.visibleTextEditors.forEach(editor => {
					if (migrationState.getChange(editor.document.uri)) {
						inlineDiffProvider.showDecorations(editor);
					}
				});
				codeLensProvider.refresh();
			}
		} catch (error) {
			vscode.window.showErrorMessage('An error occurred during migration.');
			telemetryService.sendTelemetryErrorEvent('migrationError', { error: (error as Error).message });
			console.error('Migration error:', error);
		}
	});



	// // Command to display migration test results
	const viewTestResultsCommand = vscode.commands.registerCommand('libmig.viewTestResults', async () => {
		const tempDir = context.workspaceState.get<string>('lastMigrationTempDir');
		if (!tempDir || !fs.existsSync(tempDir)) {
			vscode.window.showInformationMessage('No recent migration test results available');
			return;
		}
		const testResults = await checkTestResults(tempDir);
		showTestResultsDetail(testResults);
	});



	// // Hunk commands for inline preview
	const acceptHunkCommand = vscode.commands.registerCommand('libmig.acceptHunk', async (uri: vscode.Uri, hunkId: number) => {
		const hunk = migrationState.getHunks(uri).find(h => h.id === hunkId);
		if (!hunk || hunk.status !== 'pending') {return;}
		hunk.status = 'accepted';
		// workspace edit
		inlineDiffProvider.showDecorations(vscode.window.activeTextEditor!);
		codeLensProvider.refresh();
	});
	const rejectHunkCommand = vscode.commands.registerCommand('libmig.rejectHunk', async (uri: vscode.Uri, hunkId: number) => {
		const hunk = migrationState.getHunks(uri).find(h => h.id === hunkId);
		if (!hunk || hunk.status !== 'pending') {return;}
		hunk.status = 'rejected';
		// workspace edit
		inlineDiffProvider.showDecorations(vscode.window.activeTextEditor!);
		codeLensProvider.refresh();
	});



	// // Outdated diff view, keep for visual comparison
	const viewDiffCommand = vscode.commands.registerCommand('libmig.viewDiff', async () => {
		console.log('Viewing diff...');
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage('No active editor found.');
			return;
		}
		const originalText = editor.document.getText();
		const updatedText = originalText.replace(/requests/g, 'httpx'); // hardcoded for now
		const originalUri = vscode.Uri.parse('original:Original.py');
		const updatedUri = vscode.Uri.parse('updated:Updated.py');

		const originalProvider = vscode.workspace.registerTextDocumentContentProvider('original', {
			provideTextDocumentContent: () => originalText,
		});
		const updatedProvider = vscode.workspace.registerTextDocumentContentProvider('updated', {
			provideTextDocumentContent: () => updatedText,
		});
		context.subscriptions.push(originalProvider, updatedProvider);

		await vscode.commands.executeCommand(
			'vscode.diff',
			originalUri,
			updatedUri,
			'Migration Preview: Split Diff'
		);
	});



	// // WIP file backup and restore (look into alternate methods)
	let backupContent: string | undefined;
	const backupCommand = vscode.commands.registerCommand('libmig.backup', () => {
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			backupContent = editor.document.getText();
			vscode.window.showInformationMessage('Backup created.');
		}
	});
	const restoreCommand = vscode.commands.registerCommand('libmig.restore', async () => {
		const editor = vscode.window.activeTextEditor;
		if (editor && backupContent) {
			const edit = new vscode.WorkspaceEdit();
			const fullRange = new vscode.Range(
				editor.document.positionAt(0),
				editor.document.positionAt(editor.document.getText().length)
			);
			edit.replace(editor.document.uri, fullRange, backupContent);
			await vscode.workspace.applyEdit(edit);
			vscode.window.showInformationMessage('Backup restored.');
		}
	});



	// // Check CLI tool using '--help' flag, check config
	const healthCheck = vscode.commands.registerCommand('libmig.healthCheck', () => {
		const libmigFlags = [configService.get<boolean>('flags.forceRerun')];
		if (libmigFlags[0] !== null) {console.log("Force rerun flag:", libmigFlags[0]);}
		exec('libmig --help', (err, stdout, stderr) => {
			if (err) {
				vscode.window.showErrorMessage(`Error: ${err.message}`);
				return;
			}
			if (stderr) {
				vscode.window.showWarningMessage(`Stderr: ${stderr}`);
			}
			vscode.window.showInformationMessage(`Output: ${stdout}`);
		});
	});



	// // Set API keys for libraries.io and OpenAI(?)
	const setAPI = vscode.commands.registerCommand('libmig.setApiKey', async () => {
		const libraryKeyID = 'libmig.librariesioApiKey';
		const llmKeyID = 'libmig.openaiApiKey';

		const services = [
			{ label: 'Libraries.io', id: libraryKeyID, description: 'For library suggestions' },
			{ label: 'OpenAI', id: llmKeyID, description: 'For automated migrations' }
		];

		const selectedService = await vscode.window.showQuickPick(services, {
			placeHolder: 'Select what service the API key is for',
			title: 'API Keys: Set API Key'
		});
		if (!selectedService) {return;}

		const apiKey = await vscode.window.showInputBox({
			prompt: 'Enter your API key, or use an empty string to clear it',
			ignoreFocusOut: true,
			password: true,
		});

		if (apiKey !== undefined) {
			if (apiKey.length > 0) {
				await context.secrets.store(selectedService.id, apiKey);
				vscode.window.showInformationMessage(`API key set for: ${selectedService.label}`);
				console.log(`Set API key for ${selectedService.label}`);
			} else {
				await context.secrets.delete(selectedService.id);
				vscode.window.showInformationMessage(`API key cleared for: ${selectedService.label}`);
				console.log(`Cleared API key for ${selectedService.label}`);
			}
		}
	});



	context.subscriptions.push(migrateCommand, viewTestResultsCommand, acceptHunkCommand, rejectHunkCommand, viewDiffCommand, backupCommand, restoreCommand, healthCheck, setAPI);
}
