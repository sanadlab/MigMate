import * as vscode from 'vscode';
import { configService } from './services/config';
import { exec } from 'child_process';
import { telemetryService } from './services/telemetry';
import { logger } from './services/logging';
import { checkTestResults, showTestResultsDetail } from './services/testResults';
import * as fs from 'fs';
import { COMMANDS } from './constants';
import { MigrationService } from './migration/migrationService';
import { MigrationWebview } from './migration/migrationWebview';




export function registerCommands(context: vscode.ExtensionContext) {
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



	// // Temp to display experimental migration webview
	const viewWebviewCommand = vscode.commands.registerCommand('libmig.viewWebview', async () => {
		const webview = new MigrationWebview();
		await webview.showPreview([], 'requests', 'httpx');
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



	// // Check CLI tool using '--help' flag, check config
	const healthCheck = vscode.commands.registerCommand('libmig.healthCheck', () => {
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
				console.log(`Set API key for ${selectedService.label}`);
				logger.info(`Set API key for ${selectedService.label}`);
				vscode.window.showInformationMessage(`API key set for: ${selectedService.label}`);
			} else {
				await context.secrets.delete(selectedService.id);
				console.log(`Cleared API key for ${selectedService.label}`);
				logger.info(`Cleared API key for ${selectedService.label}`);
				vscode.window.showInformationMessage(`API key cleared for: ${selectedService.label}`);
			}
		}
	});



	context.subscriptions.push(migrateCommand, viewTestResultsCommand, viewDiffCommand, healthCheck, setAPI);
}
