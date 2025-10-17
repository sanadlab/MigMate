import * as vscode from 'vscode';
import { UpdatedContentProvider } from './updatedContentProvider';
import { HoverProvider } from './hoverProvider';
import { configService } from '../services/config';
import { PLUGIN, CONFIG } from '../constants';



export function registerProviders(context: vscode.ExtensionContext) {
    let hoverProviderDisposable: vscode.Disposable;

    function updateHoverProviderRegistration() {
        if (hoverProviderDisposable) {
            hoverProviderDisposable.dispose();
        }
        const requirementFileName = configService.get<string>(CONFIG.REQ_FILE, 'requirements.txt');
        const requirementFilePattern = `**/${requirementFileName}`;
        hoverProviderDisposable = vscode.languages.registerHoverProvider(
                // // consider doing something like
                // { language: 'toml', pattern: '**/pyproject.toml' }
                // provideHover(doc, pos) {
                //     if (document.fileName.endsWith('pyproject.toml')) {return ProvideTomlHover(doc, pos)}
                //     if (document.fileName.endsWith('requirements.txt')) {return ProvideRequirementsHover(doc, pos)}
                //     return undefined;
                // }
            [
                {language: 'plaintext', pattern: requirementFilePattern},
                {language: 'pip-requirements', pattern: requirementFilePattern}
            ],
                new HoverProvider()
        );
        context.subscriptions.push(hoverProviderDisposable);
    }
    // // Re-register hover provider if requirement file path is updated
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(`${PLUGIN}.${CONFIG.REQ_FILE}`)) {
            updateHoverProviderRegistration();
        }
    }));
    updateHoverProviderRegistration();

    // // For diff view (in Webview)
    const updatedContentProvider = new UpdatedContentProvider();
    const contentProviderRegistration = vscode.workspace.registerTextDocumentContentProvider(
        `${PLUGIN}-preview`,
        updatedContentProvider
    );
    context.subscriptions.push(contentProviderRegistration);
}

// vscode.window.registerTreeDataProvider(`${PLUGIN}-tree`)
