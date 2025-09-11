import * as vscode from 'vscode';
import { migrationState, MigrationChange } from './services/migrationState';
import { configService } from './services/config';
import { getLibrariesFromRequirements, getSourceLibrary, getTargetLibrary } from './services/librariesApi';
import { runCliTool } from './services/cli';
import { exec } from 'child_process';
import { telemetryService } from './services/telemetry';
import { codeLensProvider, InlineDiffProvider } from './providers';



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

			// // Set LibMig flags based on config
			const pythonVersion = configService.get<string>('flags.pythonVersion');
			const forceRerun = configService.get<boolean>('flags.forceRerun');

			// // Construct CLI command using flags
			let command = `libmig ${srcLib} ${tgtLib}`;
			if (pythonVersion) { command += ` --python-version=${pythonVersion}`; }
			if (forceRerun) { command += ' --force-rerun'; }

			// // Perform the migration
			vscode.window.showInformationMessage(`Migrating from library '${srcLib}' to library '${tgtLib}'...`);
			console.log(`Migration initiated from '${srcLib}' to '${tgtLib}'`);
			await runCliTool('libmig --help', cwd); // command
			telemetryService.sendTelemetryEvent('migrationCompleted', { source: srcLib, target: tgtLib });

			// // Launch Preview (check this w/ CLI tool response)
			const editor = vscode.window.activeTextEditor;
			if (!editor) {return;}
			const mockChanges: MigrationChange[] = [{
				uri: editor.document.uri,
				originalContent: editor.document.getText(),
				updatedContent: editor.document.getText().replace(new RegExp(srcLib, 'g'), tgtLib),
				hunks: [] // check this
			}];
			migrationState.loadChanges(mockChanges);

			const previewMode = configService.get<string>('flags.previewGrouping');
			console.log("Preview mode:", previewMode);
			if (previewMode === 'All at once') {
				telemetryService.sendTelemetryEvent('migrationPreview', { mode: 'grouped' });
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



	// // Hunk commands for preview
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



	context.subscriptions.push(migrateCommand, acceptHunkCommand, rejectHunkCommand, viewDiffCommand, backupCommand, restoreCommand, healthCheck, setAPI);
}
