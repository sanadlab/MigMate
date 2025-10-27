import * as vscode from 'vscode';
import * as fs from 'fs';
import { configService } from './services/config';
import { telemetryService } from './services/telemetry';
import { logger } from './services/logging';
import { checkTestResults, showTestResultsView } from './services/testResultWebview';
import { COMMANDS, API_KEY_ID } from './constants';
import { MigrationService } from './migration/migrationService';




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
		showTestResultsView(testResults);
	});



	// // Set API keys for libraries.io and OpenAI(?)
	const setAPI = vscode.commands.registerCommand(COMMANDS.SET_API_KEY, async () => {
		const services = [
			{ label: 'Libraries.io', id: API_KEY_ID.LIBRARIES, description: 'For library suggestions' },
			{ label: 'OpenAI', id: API_KEY_ID.OPENAI, description: 'For automated migrations' }
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



	context.subscriptions.push(migrateCommand, viewTestResultsCommand, setAPI);
}
