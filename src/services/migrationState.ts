import * as vscode from 'vscode';
import * as diff from 'diff';

export interface MigrationChange {
    uri: vscode.Uri,
    originalContent: string;
    updatedContent: string;
    hunks: DiffHunk[];
}

export interface DiffHunk {
    id: number;
    type: 'added' | 'removed' | 'unchanged';
    lines: string[];
    originalStartLine: number;
    status: 'pending' | 'accepted' | 'rejected';
}

class MigrationStateService {
    private changes: Map<string, MigrationChange> = new Map();

    public loadChanges(newChanges: Omit<MigrationChange, 'hunks'>[]) {
        this.changes.clear();
        newChanges.forEach(change => {
            const hunks = this.parseDiff(change.originalContent, change.updatedContent);
            this.changes.set(change.uri.toString(), { ...change, hunks });
        });
    }

    private parseDiff(original: string, updated: string): DiffHunk[] {
        const originalLines = original.split('\n');
        const updatedLines = updated.split('\n');
        const diffResult = diff.diffArrays(originalLines, updatedLines); // check this, compare lines vs arrays
        const tempHunks: DiffHunk[] = [];
        let currentLine = 0;
        let hunkId = 0;

        diffResult.forEach(part => {
            const partLines = part.value;
            if (part.added) {
                tempHunks.push({ id: hunkId++, type: 'added', lines: partLines, originalStartLine: currentLine, status: 'pending' });
            } else if (part.removed) {
                tempHunks.push({ id: hunkId++, type: 'removed', lines: partLines, originalStartLine: currentLine, status: 'pending' });
                currentLine += partLines.length;
            } else {
                currentLine += partLines.length;
            }
        });

        // // Try going through a second time to fix the mismatch in preview
        const hunks: DiffHunk[] = [];
        for (let i = 0; i < tempHunks.length; i++) {
            const hunk = tempHunks[i];
            if (hunk.type === 'added' && i > 0) {
                const prevHunk = tempHunks[i-1];
                if (prevHunk.type === 'removed') {
                    hunks.push({...hunk, originalStartLine: prevHunk.originalStartLine});
                    continue;
                }
            }
            hunks.push(hunk);
        }
        return hunks;
    }

    public handleSingleHunk(edit: vscode.WorkspaceEdit, uri: vscode.Uri, hunk: DiffHunk) {
        if (hunk.type === 'removed') {
            const startPos = new vscode.Position(hunk.originalStartLine, 0);
            const endPos = new vscode.Position(hunk.originalStartLine + hunk.lines.length, 0);
            const range = new vscode.Range(startPos, endPos);

            edit.delete(uri, range, {
                label: `Remove '${this.cleanString(hunk.lines[0]).substring(0, 20)}${hunk.lines.length > 1 ? '...' : ''}'`,
                description: `Line ${hunk.originalStartLine + 1}`,
                needsConfirmation: true,
            });
        }
        else if (hunk.type === 'added') {
            const pos = new vscode.Position(hunk.originalStartLine, 0);
            const insertText = hunk.lines.join('\n') + '\n';

            edit.insert(uri, pos, insertText, {
                label: `Add '${this.cleanString(hunk.lines[0]).substring(0, 20)}${hunk.lines.length > 1 ? '...' : ''}'`,
                description: `After line ${hunk.originalStartLine}`,
                needsConfirmation: true,
            });
        }
    }

    public cleanString(str: string): string {
        if (!str) {return '';}
        return str.replace(/\r?\n|\r/g, '').trim();
    }

    public getHunks(uri: vscode.Uri): DiffHunk[] {
        return this.changes.get(uri.toString())?.hunks || [];
    }

    getChanges(): MigrationChange[] {
        return Array.from(this.changes.values());
    }

    getChange(uri: vscode.Uri): MigrationChange | undefined {
        return this.changes.get(uri.toString());
    }

    clear() {
        this.changes.clear();
    }

    async applyAll() {
        const edit = new vscode.WorkspaceEdit();
        for (const change of this.getChanges()) {
            const fullRange = new vscode.Range(0, 0, Number.MAX_VALUE, Number.MAX_VALUE);
            edit.replace(change.uri, fullRange, change.updatedContent);
        }
        await vscode.workspace.applyEdit(edit);
        this.clear();
    }
}

export const migrationState = new MigrationStateService();
