import * as vscode from 'vscode';
import { exec, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

// // // Custom logger for telemetry (temp)
class TelemetryLogger {
	storagePath: string;
	logFilePath: string;
	isInitialized = false;

	constructor(context: vscode.ExtensionContext) {
		this.storagePath = context.globalStorageUri.fsPath;
		this.logFilePath = path.join(this.storagePath, 'telemetry-log.jsonl');
	}

	async initialize(): Promise<void> {
		try {
			await fs.mkdir(this.storagePath, {recursive: true});
			this.isInitialized = true;
			console.log('Log file:', this.logFilePath);
		} catch (error) {
			console.error('Failed to initialize telemetry logger');
		}
	}

	async logEvent(eventName: string, properties?: { [key: string]: string }): Promise<void> {
		const isTelemetryEnabled = vscode.workspace.getConfiguration('telemetry').get<boolean>('enableTelemetry');
		if (!isTelemetryEnabled) {
			console.warn('Telemetry is disabled in VSCode settings');
			return;
		}

		if (!this.isInitialized) {
			console.warn('Telemetry logger not initialized');
			return;
		}

		const event = {
			// machineID: vscode.env.machineId,
			timeStamp: new Date().toISOString(),
			name: eventName,
			properties: properties || {},
		};

		try {
			await fs.appendFile(this.logFilePath, JSON.stringify(event) + '\n');
		} catch (error) {
			console.error(`Failed to write event to log file:`, error);
		}
	}
}
let telemetryLogger: TelemetryLogger;

// // // Output channel for spawned process
let libmigChannel: vscode.OutputChannel;

// // // Interfaces for Libraries.io API
interface LibIoPackageInfo {
    keywords: string[];
}
interface LibIoSearchResult {
    name: string;
}

export async function activate(context: vscode.ExtensionContext) {
	// // Initialize temp logger & output channel
	telemetryLogger = new TelemetryLogger(context);
	await telemetryLogger.initialize();
	libmigChannel = vscode.window.createOutputChannel('LibMig');

	// // Startup logging
	console.log('Congratulations, your extension "LibMig" is now active!');
	const activeEditor = vscode.window.activeTextEditor;
	console.log('Language trigger:', activeEditor?.document.languageId);
	telemetryLogger.logEvent('pluginActivation', { trigger: `language=${activeEditor?.document.languageId}` });



	// // // WIP Configuration Handling
	let myConfig = vscode.workspace.getConfiguration('libmig');
	console.log(`Using LLM Client: ${myConfig.get('flags.LLMClient')}`);
	vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('libmig')) {
			console.log("Update LibMig configuration");
			telemetryLogger.logEvent('configChanged');
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
	context.subscriptions.push(hoverProvider);



	// // // Helper Functions
	// // Handle source library selection (two methods)
	async function getSourceLibrary(hoverLibrary: string | undefined, libraries: string[]): Promise<string | undefined> {
		if (hoverLibrary && typeof hoverLibrary === 'string') {
			console.log(`Hover library: ${hoverLibrary}`);
			return hoverLibrary;
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
	// // Handle target library selection (including filtering out srcLib)
	async function getTargetLibrary(libraries: string[], srcLib: string): Promise<string | undefined> {
		const filteredLibraries = libraries.filter(lib => lib !== srcLib);
		const targetOptions = [...filteredLibraries, '$(edit) Enter library name manually...'];
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
	// // Alt function for getTargetLibrary
	async function getAltTargetLibrary(srcLib: string): Promise<string | undefined> {
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
	// // Mocked library migration
	const migrateCommand = vscode.commands.registerCommand('libmig.migrate', async (hoverLibrary?: string) => {
		console.log('Beginning migration...');
		telemetryLogger.logEvent('migrationStarted', { trigger: hoverLibrary ? 'hover' : 'commandPalette' });
		const libraries = await getLibrariesFromRequirements();

		if (libraries.length <= 0) {
			vscode.window.showErrorMessage('No libraries found in requirements file.');
			return;
		}

		try {
			// // Get the source library
			const srcLib = await getSourceLibrary(hoverLibrary, libraries);
			if (!srcLib) {
				vscode.window.showInformationMessage('Migration cancelled: No source library selected.');
				return;
			}
			// // Get the target library
			// const tgtLib = await getTargetLibrary(libraries, srcLib);
			const tgtLib = await getAltTargetLibrary(srcLib);
			if (!tgtLib) {
				vscode.window.showInformationMessage('Migration cancelled: No target library selected.');
				telemetryLogger.logEvent('migrationCancelled', { reason: 'noTargetLibrary' });
				return;
			}
			// Perform the migration
			vscode.window.showInformationMessage(`Migrating from library '${srcLib}' to library '${tgtLib}'.`);
			console.log(`Migration initiated from '${srcLib}' to '${tgtLib}'`);
			telemetryLogger.logEvent('migrationCompleted', { source: srcLib, target: tgtLib });
		} catch (error) {
			vscode.window.showErrorMessage('An error occurred during migration.');
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

		await vscode.commands.executeCommand(
			'vscode.diff',
			originalUri,
			updatedUri,
			'Migration Preview: Split Diff'
		);
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

	// // Testing direct CLI call
	const migrateSpawn = vscode.commands.registerCommand('libmig.callLibMig', async () => {
		telemetryLogger.logEvent('migrationStarted', { trigger: 'cliCommand' });

		// // Run from open directory instead of VS Code installation path
		const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder is open. Please open a project to run this command.');
            return;
        }
        const cwd = workspaceFolders[0].uri.fsPath;
		console.log("Directory:", cwd);

		// // Take input for user arguments
		const sourceLib = await vscode.window.showInputBox({ prompt: 'Enter the source library' });
		const targetLib = await vscode.window.showInputBox({ prompt: 'Enter the target library' });

		// // Set flags based on config (WIP)
		const pythonVersion = myConfig.get<string>('flags.pythonVersion');
		const forceRerun = myConfig.get<boolean>('flags.forceRerun');

		if (sourceLib && targetLib && pythonVersion) {
			let command = `libmig ${sourceLib} ${targetLib} --python-version=${pythonVersion}`;
			// // Add additional args to command if needed
			if (forceRerun) { command += ' --force-rerun'; }
			vscode.window.showInformationMessage('Starting migration...');
			await runCliTool(command, cwd);
			telemetryLogger.logEvent('migrationCompleted', { source: sourceLib, target: targetLib });
		} else {
			vscode.window.showErrorMessage('Migration cancelled: Missing required inputs.');
			console.error(`sourceLib=${sourceLib}, targetLib=${targetLib}, pythonVer=${pythonVersion}`);
			telemetryLogger.logEvent('migrationCancelled', { reason: 'missingInputs' });
		}
	});
	context.subscriptions.push(migrateSpawn);

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
