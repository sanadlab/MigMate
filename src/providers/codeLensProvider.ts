import * as vscode from 'vscode';
import { migrationState } from '../services/migrationState';

export class CodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    public refresh() {
        this._onDidChangeCodeLenses.fire();
    }

    provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens[]> {
        const hunks = migrationState.getHunks(document.uri);
        if (hunks.length === 0) {return [];}

        const codeLenses: vscode.CodeLens[] = [];

        const sortedHunks = [...hunks].sort((a, b) => a.originalStartLine - b.originalStartLine);
        for (const hunk of sortedHunks) {
            if (hunk.status !== 'pending') {continue;}
            const startLine = hunk.originalStartLine;
            const range = new vscode.Range(startLine, 0, startLine, 0);

            // // Not registered for end user
            const acceptCommand: vscode.Command = {
                title: 'Accept',
                command: 'libmig.acceptHunk',
                arguments: [document.uri, hunk.id]
            };
            const rejectCommand: vscode.Command = {
                title: 'Reject',
                command: 'libmig.rejectHunk',
                arguments: [document.uri, hunk.id]
            };

            if (hunk.type === 'added') {
                // for (let i = 0; i < hunk.lines.length; i++) {
                    // const line = hunk.lines[i];
                    const addedCodeTitle = hunk.lines.map(line => `+ ${line}`).join('\n'); // check this
                    codeLenses.push(new vscode.CodeLens(range, {
                        title: addedCodeTitle,
                        // title: `+ ${line}`,
                        command: ''
                    }));
                //     console.log(i);
                // }
                codeLenses.push(new vscode.CodeLens(range, acceptCommand));
                codeLenses.push(new vscode.CodeLens(range, rejectCommand));
            }
            else if (hunk.type === 'removed') {
                codeLenses.push(new vscode.CodeLens(range, acceptCommand));
                codeLenses.push(new vscode.CodeLens(range, rejectCommand));
            }
        }

        return codeLenses;
    }
}
