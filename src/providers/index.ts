import * as vscode from 'vscode';
import { registerContentProvider } from './updatedContentProvider';
import { registerHoverProvider } from './hoverProvider';
import { CodeLensProvider } from './codeLensProvider';



export { InlineDiffProvider } from './inlineDiffProvider';


let _codeLensProvider: CodeLensProvider | undefined;
export function getCodeLensProvider(): CodeLensProvider {
    if (!_codeLensProvider) {
        _codeLensProvider = new CodeLensProvider();
        console.log("CodeLensProvider created:", _codeLensProvider);
    }
    return _codeLensProvider;
}


export function registerProviders(context: vscode.ExtensionContext) {
    registerHoverProvider(context);
    registerContentProvider(context);

    const codeLensProviderRegistration = vscode.languages.registerCodeLensProvider(
        { scheme: 'file' },
        getCodeLensProvider()
    );
    context.subscriptions.push(codeLensProviderRegistration);
}

// vscode.window.registerTreeDataProvider('libmig-libraries')
