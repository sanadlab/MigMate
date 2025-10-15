import * as vscode from 'vscode';
import { migrationState } from '../migration/migrationState';



export class UpdatedContentProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    public provideTextDocumentContent(uri: vscode.Uri): string {
        const originalFileUri = vscode.Uri.file(uri.path);
        const change = migrationState.getChange(originalFileUri);

        return change ? change.updatedContent : '';
    }
}
