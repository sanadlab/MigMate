import * as vscode from 'vscode';
import * as diff from 'diff';
import { migrationState } from '../services/migrationState';

export class InlineDiffProvider {
    // private addedDecoration = vscode.window.createTextEditorDecorationType({
    //     backgroundColor: 'rgba(0, 255, 0, 0.25)',
    //     isWholeLine: true,
    // });
    private removedDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255, 0, 0, 0.25)',
        isWholeLine: true,
    });

    public showDecorations(editor: vscode.TextEditor) {
        const change = migrationState.getChange(editor.document.uri);
        if(!change) {return;};

        const diffResult = diff.diffLines(change.originalContent, change.updatedContent);
        const removedRanges: vscode.Range[] = [];
        let currentLine = 0;

        diffResult.forEach(part => {
            const lineCount = part.count || 0;
            if (part.removed) {
                const start = new vscode.Position(currentLine, 0);
                const end = new vscode.Position(currentLine + lineCount - 1, 0);
                removedRanges.push(new vscode.Range(start, end));
            }

            if (!part.added) {
                currentLine += lineCount;
            }
        });

        editor.setDecorations(this.removedDecoration, removedRanges);
    }

    public clearDecorations(editor: vscode.TextEditor) {
        // editor.setDecorations(this.addedDecoration, []);
        editor.setDecorations(this.removedDecoration, []);
    }
}
