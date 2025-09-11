import * as vscode from 'vscode';
import { registerContentProvider } from './updatedContentProvider';
import { registerHoverProvider } from './hoverProvider';
import { CodeLensProvider } from './codeLensProvider';



export { InlineDiffProvider } from './inlineDiffProvider';
export const codeLensProvider = new CodeLensProvider();

export function registerProviders(context: vscode.ExtensionContext) {
    registerHoverProvider(context);
    registerContentProvider(context);

    const codeLensProviderRegistration = vscode.languages.registerCodeLensProvider(
        { scheme: 'file' },
        codeLensProvider
    );
    context.subscriptions.push(codeLensProviderRegistration);
}

// vscode.window.registerTreeDataProvider('libmig-libraries')
