import * as vscode from 'vscode';
import { DiffHunk } from './migrationState';

export class DiffUtils {
    public static normalizeEOL(content: string, targetEOL: string = '\n'): string {
        return content.replace(/\r\n|\n|\r/g, targetEOL);
    }

    public static getDocumentEOL(doc: vscode.TextDocument): string {
        return doc.eol === vscode.EndOfLine.LF ? '\n' : '\r\n';
    }

    public static getReplacementText(additionHunk: DiffHunk, doc: vscode.TextDocument): string {
        const eol = this.getDocumentEOL(doc);
        let newText = additionHunk.lines.join(eol);

        // Check if the change is at EOF
        const isAtEOF = additionHunk.originalStartLine >= doc.lineCount - 1;
        const endsWithEol = doc.getText().endsWith(eol);

        if (isAtEOF) {
            if (endsWithEol && !newText.endsWith(eol)) {
                newText += eol;
            }
            else if (!endsWithEol && newText.endsWith(eol)) {
                newText = newText.slice(0, -eol.length);
            }
        } else if (additionHunk.lines.length > 0 && !newText.endsWith(eol)) {
            newText += eol;
        }
        return newText;
    }

    // // Create a workspace edit for applying a hunk
    public static createHunkEdit(hunk: DiffHunk, uri: vscode.Uri, eol: string, pairedHunk?: DiffHunk, confirm: boolean = true): vscode.WorkspaceEdit {
        const edit = new vscode.WorkspaceEdit();

        // // Handle paired hunks as replacements
        if (pairedHunk) {
            const removalHunk = hunk.type === 'removed' ? hunk : pairedHunk;
            const additionHunk = hunk.type === 'added' ? hunk : pairedHunk;

            const range = new vscode.Range(
                new vscode.Position(removalHunk.originalStartLine, 0),
                new vscode.Position(removalHunk.originalStartLine + removalHunk.lines.length, 0)
            );

            // // Ensure proper EOL handling
            const newText = additionHunk.lines.join(eol) + (additionHunk.lines.length > 0 ? eol : '');

            edit.replace(uri, range, newText, {
                label: `Replace code at line ${removalHunk.originalStartLine + 1}`,
                needsConfirmation: confirm
            });
        }
        // // Handle standalone hunks
        else if (hunk.type === 'removed') {
            const range = new vscode.Range(
                new vscode.Position(hunk.originalStartLine, 0),
                new vscode.Position(hunk.originalStartLine + hunk.lines.length, 0)
            );

            edit.delete(uri, range, {
                label: `Remove code at line ${hunk.originalStartLine + 1}`,
                needsConfirmation: confirm
            });
        }
        else if (hunk.type === 'added') {
            const pos = new vscode.Position(hunk.originalStartLine, 0);
            let insertText = hunk.lines.join(eol);

            // Handle empty string
            if (hunk.lines.length === 1 && hunk.lines[0] === '') {
                insertText = eol;
            }

            edit.insert(uri, pos, insertText, {
                label: `Add code at line ${hunk.originalStartLine + 1}`,
                needsConfirmation: confirm
            });
        }
        return edit;
    }

    // // Check if a hunk has been applied to content
    public static isHunkApplied(hunk: DiffHunk, beforeContent: string, afterContent: string): boolean {
        const normalizedBefore = this.normalizeEOL(beforeContent);
        const normalizedAfter = this.normalizeEOL(afterContent);
        const hunkContent = this.normalizeEOL(hunk.lines.join('\n'));

        if (hunk.type === 'added') {
            return normalizedAfter.includes(hunkContent);
        }
        if (hunk.type === 'removed') {
            return normalizedBefore.includes(hunkContent) && !normalizedAfter.includes(hunkContent);
        }
        return false;
    }

    // Find the paired hunk for the given hunk
    public static findPairedHunk(hunk: DiffHunk, hunks: DiffHunk[]): DiffHunk | undefined {
        if (hunk.pairedHunkId !== undefined) {
            return hunks.find(h => h.id === hunk.pairedHunkId);
        }
        return undefined;
    }
}
