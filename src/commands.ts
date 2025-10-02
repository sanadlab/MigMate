import * as vscode from 'vscode';
import { migrationState, MigrationChange } from './services/migrationState';
import { configService } from './services/config';
import { getLibrariesFromRequirements, getSourceLibrary, getTargetLibrary } from './services/librariesApi';
import { runCliTool, buildCliCommand } from './services/cli';
import { exec, execSync } from 'child_process';
import { telemetryService } from './services/telemetry';
import { logger } from './services/logging';
import { codeLensProvider, InlineDiffProvider } from './providers';
import { checkTestResults, showTestResultsDetail } from './services/testResults';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';


import { COMMANDS } from './constants';
import { MigrationService } from './migration/migrationService';




export function registerCommands(context: vscode.ExtensionContext) {
    const inlineDiffProvider = new InlineDiffProvider(); // might remove // check this
	const migrationService = new MigrationService(context);



	// // Perform a library migration
	const migrateCommand = vscode.commands.registerCommand(COMMANDS.MIGRATE, async (hoverLibrary?: string) => {
		await migrationService.runMigration(hoverLibrary);
	});



	// // Command to display migration test results
	const viewTestResultsCommand = vscode.commands.registerCommand(COMMANDS.VIEW_TEST_RESULTS, async () => {
		const resultsDir = context.workspaceState.get<string>('lastMigrationResults');
		if (!resultsDir || !fs.existsSync(resultsDir)) {
			vscode.window.showInformationMessage('No recent migration test results available');
			return;
		}
		const testResults = await checkTestResults(resultsDir);
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
