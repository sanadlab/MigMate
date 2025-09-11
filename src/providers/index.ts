import * as vscode from 'vscode';
import { registerContentProvider } from './updatedContentProvider';
import { registerHoverProvider } from './hoverProvider';



export function registerProviders(context: vscode.ExtensionContext) {
    registerHoverProvider(context);
    registerContentProvider(context);
}

// vscode.window.registerTreeDataProvider('libmig-libraries')
