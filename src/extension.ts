import * as vscode from 'vscode';
import { exec } from 'child_process';

export function activate(context: vscode.ExtensionContext) {

	// // Startup logging
	console.log('Congratulations, your extension "LibMig" is now active!');
	const activeEditor = vscode.window.activeTextEditor;
	console.log('Language trigger:', activeEditor?.document.languageId);



	// // // WIP Configuration Handling
	let myConfig = vscode.workspace.getConfiguration('libmig');
	console.log(`Using LLM Client: ${myConfig.get('flags.LLMClient')}`);
	vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('libmig')) {
			console.log("Update LibMig configuration");
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
		console.log('Prompting user to select a source library...');
		return await vscode.window.showQuickPick(libraries, {
			placeHolder: 'Select a source library to migrate *FROM*',
		});
	}
	// // Handle target library selection (including filtering out srcLib)
	async function getTargetLibrary(libraries: string[], srcLib: string): Promise<string | undefined> {
		const filteredLibraries = libraries.filter(lib => lib !== srcLib);
		console.log('Prompting user to select a target library...');
		return await vscode.window.showQuickPick(filteredLibraries, {
			placeHolder: 'Select a target library to migrate *TO*',
		});
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
	// // Run target command in CLI
	function runCliTool(command: string, cwd: string) {
		return new Promise<void>((resolve, reject) => {
			exec(command, {cwd}, (err, stdout, stderr) => {
				if (err) {
					vscode.window.showErrorMessage(`Error: ${err.message}`);
					reject(err);
					return;
				}
				if (stderr) {
					vscode.window.showWarningMessage(`Stderr: ${stderr}`);
				}
				vscode.window.showInformationMessage(`Output: ${stdout}`);
				resolve();
			});
		});
	}



	// // // Register Commands
	// // Hello World command for health check
	const helloWorldCommand = vscode.commands.registerCommand('libmig.helloWorld', () => {
		console.log('HelloWorld command executed');
		vscode.window.showInformationMessage('Hello World from LibMig!');
	});
	context.subscriptions.push(helloWorldCommand);

	// // WIP library migration
	const migrateCommand = vscode.commands.registerCommand('libmig.migrate', async (hoverLibrary?: string) => {
		console.log('Beginning migration...');
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
			const tgtLib = await getTargetLibrary(libraries, srcLib);
			if (!tgtLib) {
				vscode.window.showInformationMessage('Migration cancelled: No target library selected.');
				return;
			}
			// Perform the migration
			vscode.window.showInformationMessage(`Migrating from library '${srcLib}' to library '${tgtLib}'.`);
			console.log(`Migration initiated from '${srcLib}' to '${tgtLib}'`);
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

	// // Alternative Library Migration w/ Configuration
	const altMigration = vscode.commands.registerCommand('libmig.altMigrate', () => {
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
	context.subscriptions.push(altMigration);

	// // Testing direct CLI call
	const migrateSpawn = vscode.commands.registerCommand('libmig.callLibMig', async () => {
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
		} else {
			vscode.window.showErrorMessage('Migration cancelled: Missing required inputs.');
		}
	});
	context.subscriptions.push(migrateSpawn);
}

export function deactivate() {}
