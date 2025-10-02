import * as vscode from 'vscode';
import { TelemetryReporter } from '@vscode/extension-telemetry';
import { registerCommands } from './commands';
import { registerProviders } from './providers';
import { configService } from './services/config';
import { telemetryService } from './services/telemetry';
import { contextService } from './services/context';
import { logger } from './services/logging';



export function activate(context: vscode.ExtensionContext) {
	// // // Initialize telemetry, output channel
	const connectionString = 'InstrumentationKey=42acdffc-3ef3-4cf0-9542-b288f124283b;IngestionEndpoint=https://westus2-2.in.applicationinsights.azure.com/;LiveEndpoint=https://westus2.livediagnostics.monitor.azure.com/;ApplicationId=396883d1-1f45-43f7-8db2-fe39284e88a8';
	const reporter = new TelemetryReporter(connectionString);
	context.subscriptions.push(reporter);
	context.subscriptions.push(logger);

	// // Initialize services
	contextService.initialize(context);
	telemetryService.initialize(reporter);
	configService.initialize(context);

	// // Register commands and providers
	registerProviders(context);
	registerCommands(context);

	// // Startup logging
	console.log('Congratulations, your extension "LibMig" is now active!');
	const activeEditor = vscode.window.activeTextEditor;
	console.log('Language trigger:', activeEditor?.document.languageId);
	telemetryService.sendTelemetryEvent('pluginActivation', { trigger: `language=${activeEditor?.document.languageId}` });
}



export function deactivate() {}
