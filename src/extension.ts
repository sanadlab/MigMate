import * as vscode from 'vscode';
import { exec, spawn } from 'child_process';
import { TelemetryReporter } from '@vscode/extension-telemetry';

import { migrationState, MigrationChange } from './migrationState';
import { InlineDiffProvider } from './inlineDiffProvider';



// // // VS Code Telemetry Setup
const connectionString = 'InstrumentationKey=42acdffc-3ef3-4cf0-9542-b288f124283b;IngestionEndpoint=https://westus2-2.in.applicationinsights.azure.com/;LiveEndpoint=https://westus2.livediagnostics.monitor.azure.com/;ApplicationId=396883d1-1f45-43f7-8db2-fe39284e88a8';
let reporter: TelemetryReporter | undefined;

// // // Output channel for spawned process
let libmigChannel: vscode.OutputChannel;

// // // Interfaces for Libraries.io API
interface LibIoPackageInfo {
    keywords: string[];
}
interface LibIoSearchResult {
    name: string;
}

export function activate(context: vscode.ExtensionContext) {
	// // // Initialize telemetry & output channel
	reporter = new TelemetryReporter(connectionString);
	libmigChannel = vscode.window.createOutputChannel('LibMig');
	context.subscriptions.push(reporter);
	context.subscriptions.push(libmigChannel);

	// // Startup logging
	console.log('Congratulations, your extension "LibMig" is now active!');
	const activeEditor = vscode.window.activeTextEditor;
	console.log('Language trigger:', activeEditor?.document.languageId);
	reporter?.sendTelemetryEvent('pluginActivation', { trigger: `language=${activeEditor?.document.languageId}` });



	// // // WIP Configuration Handling
	let myConfig = vscode.workspace.getConfiguration('libmig');
	console.log(`Using LLM Client: ${myConfig.get('flags.LLMClient')}`);
	vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('libmig')) {
			console.log("Update LibMig configuration");
			reporter?.sendTelemetryEvent('configChanged');
			myConfig = vscode.workspace.getConfiguration('libmig');
		}
	});



	// // // Extension Providers
	// vscode.window.registerTreeDataProvider('libmig-libraries')
	const hoverProvider = vscode.languages.registerHoverProvider(
		[
			{language: 'plaintext', pattern: '**/requirements.txt'},
			{language: 'pip-requirements'}
		],
		{
			provideHover(document, position) {
				const range = document.getWordRangeAtPosition(position, /[a-zA-Z0-9-_]+/);
				const word = range ? document.getText(range) : null;

				if (word) {
					console.log(`Hover detected on word: ${word}`);
					const markdown = new vscode.MarkdownString(
						`**LibMig Plugin:**\n\n[Migrate \`${word}\`](command:libmig.migrate?${JSON.stringify(word)})`
					);
					markdown.isTrusted = true;
					return new vscode.Hover(markdown);
            	}
				return undefined;
			}
		}
	);
	const inlineDiffProvider = new InlineDiffProvider();
	const updatedContentProvider = vscode.workspace.registerTextDocumentContentProvider('libmig-migrated', {
		provideTextDocumentContent: uri => {
			const originalUri = vscode.Uri.file(uri.path);
			return migrationState.getChange(originalUri)?.updatedContent;
		}
	});
	context.subscriptions.push(hoverProvider, updatedContentProvider);



	// // // Helper Functions
	// // Handle source library selection (two methods)
	async function getSourceLibrary(hoverLibrary: string | undefined, libraries: string[]): Promise<string | undefined> {
		if (hoverLibrary && typeof hoverLibrary === 'string') {
			console.log(`Hover library: ${hoverLibrary}`);
			return hoverLibrary;
		}

		if (libraries.length <= 0) {
            return await vscode.window.showInputBox({ prompt: 'Enter the source library name' });
        }

		const sourceOptions = [...libraries, '$(edit) Enter library name manually...'];
		console.log('Prompting user to select a source library...');
		const sourceChoice = await vscode.window.showQuickPick(sourceOptions, {
            placeHolder: 'Select a source library to migrate *FROM*',
			title: 'Migration: Select Source'
        });

        if (sourceChoice?.includes('Enter library name manually')) {
            return await vscode.window.showInputBox({ prompt: 'Enter the source library name' });
        }
        return sourceChoice;
	}
	// // Handle target library selection
	async function getTargetLibrary(srcLib: string): Promise<string | undefined> {
		const suggestionsEnabled = myConfig.get<boolean>('options.enableSuggestions.(Experimental)');
		if (!suggestionsEnabled) {
			console.warn('Target library suggestions are disabled');
			return await vscode.window.showInputBox({ prompt: 'Enter the target library name' });
		}

		const suggestions = await getSuggestedLibraries(srcLib);
		const targetOptions = [...suggestions, '$(edit) Enter library name manually...'];
		console.log('Prompting user to select a target library...');
		const targetChoice = await vscode.window.showQuickPick(targetOptions, {
			placeHolder: 'Select a target library to migrate *TO*',
			title: 'Migration: Select Target'
		});

		if (targetChoice?.includes('Enter library name manually')) {
            return await vscode.window.showInputBox({ prompt: 'Enter the target library name' });
        }
        return targetChoice;
	}
	// // Parse requirements.txt to get library names
	async function getLibrariesFromRequirements(): Promise<string[]> {
		const editor = vscode.window.activeTextEditor;
		if (!editor || !editor.document.fileName.endsWith('requirements.txt')) {
			return [];
		}
		const text = editor.document.getText();
		const libraries = text.match(/[a-zA-Z0-9-_]+/g) || [];
		return Array.from(new Set(libraries));
	}
	// // WIP alternative to existing target library recommendations
	async function getSuggestedLibraries(srcLib: string): Promise<string[]> {
		const suggestionsEnabled = myConfig.get<boolean>('options.enableSuggestions');
		if (!suggestionsEnabled) {console.warn('Target library suggestions are disabled'); return [];}

		const libraryKeyID = 'libmig.librariesioApiKey';
		let apiKey = await context.secrets.get(libraryKeyID);
		if (!apiKey) {
			const selection = await vscode.window.showWarningMessage(
				'No API key is set for Libraries.io',
				'Set API Key', 'Proceed w/o suggestions'
			);

			if (selection === 'Set API Key') {
				await vscode.commands.executeCommand('libmig.setApiKey');
				apiKey = await context.secrets.get(libraryKeyID);
				if (!apiKey) {
					console.warn("No Libraries.io API key provided");
					return [];
				}
			} else {
				console.warn("No Libraries.io API key provided - proceeding without suggestions");
				return [];
			}
		}

		try {
			const libURL = `https://libraries.io/api/PyPI/${srcLib}?api_key=${apiKey}`;
            const libResponse = await fetch(libURL);
			if (!libResponse.ok) {
				console.error(`Failed to retrieve information for ${srcLib}: ${libResponse.statusText}`);
				return [];
			}
			const libData = await libResponse.json() as LibIoPackageInfo;
			const keywords = libData.keywords;
			if (!keywords || keywords.length === 0) {
				console.log(`No keywords found for ${srcLib}`);
				return [];
			}

			const genericKeys = new Set(['python', 'library', 'pypi', 'api', 'client', 'wrapper', 'json', 'development', 'tool']);
			const specificKeys = keywords.filter(k => !genericKeys.has(k.toLowerCase()));
			if (specificKeys.length === 0) {console.log("No specific keywords after filtering"); return [];}

			const searchURL = `https://libraries.io/api/search?platforms=PyPI&keywords=${specificKeys.join(',')}&api_key=${apiKey}`;
			console.log("Search URL:", searchURL.split('&api_key')[0]);
			const searchResponse = await fetch(searchURL);
			if (!searchResponse.ok) {
                console.error(`Failed to search for similar libraries: ${searchResponse.statusText}`);
                return [];
            }
			const searchData = await searchResponse.json() as LibIoSearchResult[];
			const suggestions = searchData.map((pkg: any) => pkg.name as string)
                .filter((name: string) => name.toLowerCase() !== srcLib.toLowerCase())
                .slice(0, 8);
            console.log(`Suggestions for ${srcLib}:`, suggestions);
            return suggestions;
		} catch (error) {
            vscode.window.showErrorMessage('Failed to fetch library suggestions from Libraries.io');
            console.error(error);
            return [];
        }
	}
	// // Run target command in CLI
	function runCliTool(command: string, cwd: string) {
		return new Promise<void>((resolve, reject) => {
			libmigChannel.show(true);
			libmigChannel.clear();
			libmigChannel.appendLine(`Running command: ${command}\n`);

			const [cmd, ...args] = command.split(' ');
			const child = spawn(cmd, args, { cwd, shell: true });

			child.stdout.on('data', (data: Buffer) => {
				libmigChannel.append(data.toString());
			});
			child.stderr.on('data', (data: Buffer) => {
				libmigChannel.append(data.toString());
			});
			child.on('close', (code) => {
				libmigChannel.appendLine(`\nCommand finished with exit code: ${code}`);
				if (code === 0) {
					vscode.window.showInformationMessage('LibMig process completed successfully');
					resolve();
				} else {
					vscode.window.showErrorMessage(`LibMig process failed with exit code ${code}`);
					reject(new Error(`Process failed with exit code ${code}`));
				}
			});
			child.on('error', (err) => {
				vscode.window.showErrorMessage(`Failed with error: ${err.message}`);
				libmigChannel.appendLine(`\nError: ${err.message}`);
				reject(err);
			});
		});
	}



	// // // Register Commands
	// // Perform a library migration
	const migrateCommand = vscode.commands.registerCommand('libmig.migrate', async (hoverLibrary?: string) => {
		console.log('Beginning migration...');
		reporter?.sendTelemetryEvent('migrationStarted', { trigger: hoverLibrary ? 'hover' : 'commandPalette' }); // check this for context menu

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
				reporter?.sendTelemetryEvent('migrationCancelled', { reason: 'noSourceLibrary' });
				return;
			}
			const tgtLib = await getTargetLibrary(srcLib);
			if (!tgtLib) {
				vscode.window.showInformationMessage('Migration cancelled: No target library selected.');
				reporter?.sendTelemetryEvent('migrationCancelled', { reason: 'noTargetLibrary' });
				return;
			}

			// // Set LibMig flags based on config
			const pythonVersion = myConfig.get<string>('flags.pythonVersion');
			const forceRerun = myConfig.get<boolean>('flags.forceRerun');

			// // Construct CLI command using flags
			let command = `libmig ${srcLib} ${tgtLib}`;
			if (pythonVersion) { command += ` --python-version=${pythonVersion}`; }
			if (forceRerun) { command += ' --force-rerun'; }

			// // Perform the migration
			vscode.window.showInformationMessage(`Migrating from library '${srcLib}' to library '${tgtLib}'...`);
			console.log(`Migration initiated from '${srcLib}' to '${tgtLib}'`);
			await runCliTool('libmig --help', cwd);
			reporter?.sendTelemetryEvent('migrationCompleted', { source: srcLib, target: tgtLib, version: pythonVersion });

			// // Launch Preview (check this w/ CLI tool response)
			const editor = vscode.window.activeTextEditor;
			if (!editor) {return;}
			const mockChanges: MigrationChange[] = [{
				uri: editor.document.uri,
				originalContent: editor.document.getText(),
				updatedContent: editor.document.getText().replace(new RegExp(srcLib, 'g'), tgtLib)
			}];
			migrationState.loadChanges(mockChanges);
			const previewMode = myConfig.get<string>('flags.previewGrouping');
			console.log("Preview mode:", previewMode);
			if (previewMode === 'All at once') {
				// log grouped preview
				const edit = new vscode.WorkspaceEdit();
				const changes = migrationState.getChanges();
				if (changes.length === 0) {
					vscode.window.showInformationMessage('No changes made during migration');
				}
				for (const change of changes) {
					const fullRange = new vscode.Range(0, 0, Number.MAX_VALUE, Number.MAX_VALUE);
					const metadata: vscode.WorkspaceEditEntryMetadata = {
						label: `Migrate ${srcLib} to ${tgtLib}`,
						description: `Full file migration for ${vscode.workspace.asRelativePath(change.uri)}`,
						needsConfirmation: true,
					};
					edit.replace(change.uri, fullRange, change.updatedContent, metadata);
				}
				await vscode.workspace.applyEdit(edit, { isRefactoring: true });
				migrationState.clear();
			}
			else {
				// log individual preview
				vscode.window.visibleTextEditors.forEach(editor => {
					if (migrationState.getChange(editor.document.uri)) {
						inlineDiffProvider.showDecorations(editor);
					}
				});
			}
		} catch (error) {
			vscode.window.showErrorMessage('An error occurred during migration.');
			reporter?.sendTelemetryErrorEvent('migrationError', { error: (error as Error).message });
			console.error('Migration error:', error);
		}
	});
	context.subscriptions.push(migrateCommand);

	// // WIP diff view
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

		// await vscode.commands.executeCommand(
		// 	'vscode.diff',
		// 	originalUri,
		// 	updatedUri,
		// 	'Migration Preview: Split Diff'
		// );



		const edit = new vscode.WorkspaceEdit();
		const metadata: vscode.WorkspaceEditEntryMetadata = {
			label: 'Migrate requests --> httpx',
			description: 'Replace imports',
			needsConfirmation: true,
		};
		edit.replace(originalUri, new vscode.Range(0, 0, 0, 0), 'import httpx', metadata);
		await vscode.workspace.applyEdit(edit, { isRefactoring: true });
	});
	context.subscriptions.push(viewDiffCommand);

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
	context.subscriptions.push(backupCommand, restoreCommand);

	// // Check CLI tool using '--help' flag, check config
	const healthCheck = vscode.commands.registerCommand('libmig.healthCheck', () => {
		const libmigFlags = [myConfig.get<boolean>('flags.forceRerun')];
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
	context.subscriptions.push(healthCheck);

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
	context.subscriptions.push(setAPI);
}

export function deactivate() {}
