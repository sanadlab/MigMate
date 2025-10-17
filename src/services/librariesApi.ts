import * as vscode from 'vscode';
import { configService } from './config';
import { telemetryService } from './telemetry';
import { contextService } from './context';
import { COMMANDS, CONFIG } from '../constants';



// // // Interfaces for Libraries.io API
interface LibIoPackageInfo {
    keywords: string[];
}
interface LibIoSearchResult {
    name: string;
}



// // Handle source library selection (two methods)
export async function getSourceLibrary(hoverLibrary: string | undefined, libraries: string[]): Promise<string | undefined> {
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
export async function getTargetLibrary(srcLib: string): Promise<string | undefined> {
    const suggestionsEnabled = configService.get<boolean>(CONFIG.LIBRARY_SUGGESTIONS);
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
export async function getLibrariesFromRequirements(): Promise<string[]> {
    const reqFileName = configService.get<string>(CONFIG.REQ_FILE) || 'requirements.txt';

    // // Check the active editor
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.fileName.toLowerCase().endsWith(reqFileName)) {
        const text = editor.document.getText();
        const libraries = text.match(/[a-zA-Z0-9-_]+/g) || [];
        return Array.from(new Set(libraries));
    }

    // // Search workspace
    const files = await vscode.workspace.findFiles(
        `**/${reqFileName}`,
        '**/{node_modules,venv,.venv,__pycache__}/**',
        1
    );
    if (files.length === 0) {
        vscode.window.showWarningMessage(`No '${reqFileName}' found in workspace.`);
        return [];
    }

    let reqFile = files[0];
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
        const root = workspaceFolders[0].uri.fsPath;
        const rootFile = files.find(f => f.fsPath.toLowerCase() === `${root}\\${reqFileName}`
        || f.fsPath.toLowerCase() === `${root}/${reqFileName}`);
        if (rootFile) {reqFile = rootFile;}
    }

    const doc = await vscode.workspace.openTextDocument(reqFile);
    const text = doc.getText();
    const libraries = text.match(/[a-zA-Z0-9-_]+/g) || [];
    return Array.from(new Set(libraries));
}

// // WIP alternative to existing target library recommendations
export async function getSuggestedLibraries(srcLib: string): Promise<string[]> {
    const suggestionsEnabled = configService.get<boolean>(CONFIG.LIBRARY_SUGGESTIONS);
    if (!suggestionsEnabled) {console.warn('Target library suggestions are disabled'); return [];}

    const libraryKeyID = CONFIG.LIBRARY_SUGGESTIONS;
    let apiKey = await contextService.secrets.get(libraryKeyID);
    if (!apiKey) {
        const selection = await vscode.window.showWarningMessage(
            'No API key is set for Libraries.io',
            'Set API Key', 'Proceed w/o suggestions'
        );

        if (selection === 'Set API Key') {
            await vscode.commands.executeCommand(COMMANDS.SET_API_KEY);
            apiKey = await contextService.secrets.get(libraryKeyID);
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
        telemetryService.sendTelemetryEvent('librarySuggestionsReceived', {source: srcLib, suggestions: suggestions.join(',')});
        console.log(`Suggestions for ${srcLib}:`, suggestions);
        return suggestions;
    } catch (error) {
        vscode.window.showErrorMessage('Failed to fetch library suggestions from Libraries.io');
        telemetryService.sendTelemetryErrorEvent('librarySuggestionsFailed', {source: srcLib});
        console.error(error);
        return [];
    }
}
