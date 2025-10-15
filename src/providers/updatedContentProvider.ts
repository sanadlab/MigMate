import * as vscode from 'vscode';
import { migrationState } from '../migration/migrationState';



export function registerContentProvider(context: vscode.ExtensionContext) {
    const contentProvider = vscode.workspace.registerTextDocumentContentProvider('libmig-migrated', {
        provideTextDocumentContent: uri => {
            const originalUri = vscode.Uri.file(uri.path);
            return migrationState.getChange(originalUri)?.updatedContent;
        }
    });
    context.subscriptions.push(contentProvider);
}
