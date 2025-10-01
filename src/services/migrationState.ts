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
        // // Normalize the line endings, should fix the current preview issue
        const originalLines = original.replace(/\r\n/g, '\n').split('\n');
        const updatedLines = updated.replace(/\r\n/g, '\n').split('\n');
        const diffResult = diff.diffArrays(originalLines, updatedLines); // check this, compare lines vs arrays

        const hunks: DiffHunk[] = [];
        let originalLine = 0;
        let id = 0;
        let lastRemovedStart: number | null = null;
        for (const part of diffResult) {
            const lines = (part.value as string[]) ?? [];
            if (part.removed) {
                const start = originalLine;
                hunks.push({id: id++, type: 'removed', lines, originalStartLine: start, status: 'pending'});
                originalLine += lines.length;
                lastRemovedStart = start;
            }
            else if (part.added) {
                const start = (lastRemovedStart !== null) ? lastRemovedStart : originalLine;
                hunks.push({id: id++, type: 'added', lines, originalStartLine: start, status: 'pending'});
                lastRemovedStart = null;
            }
            else {
                originalLine += lines.length;
                lastRemovedStart = null;
            }
        }
        return hunks;
    }

    public handleSingleHunk(edit: vscode.WorkspaceEdit, uri: vscode.Uri, hunk: DiffHunk, eol: string = '\n') {
        if (hunk.type === 'removed') {
            const startPos = new vscode.Position(hunk.originalStartLine, 0);
            const endPos = new vscode.Position(hunk.originalStartLine + hunk.lines.length, 0);
            const range = new vscode.Range(startPos, endPos);

            edit.delete(uri, range, {
                label: `Remove '${this.cleanString(hunk.lines[0]).substring(0, 20)}${hunk.lines.length > 1 ? '...' : ''}'`,
                description: `Lines ${hunk.originalStartLine + 1} - ${hunk.originalStartLine + hunk.lines.length}`,
                needsConfirmation: true,
            });
        }
        else if (hunk.type === 'added') {
            const pos = new vscode.Position(hunk.originalStartLine, 0);
            // const insertText = hunk.lines.join('\n') + '\n';
            let insertText = hunk.lines.join(eol);

            // // Case where EOF tries to add empty string? check this
            if (hunk.lines.length === 1 && hunk.lines[0] === '' && hunk.originalStartLine >= 0) {
                insertText = eol; // might want to check current EOF char instead of always adding
            }

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
            const doc = await vscode.workspace.openTextDocument(change.uri);
            const eol = doc.eol === vscode.EndOfLine.LF ? '\n' : '\r\n';
            const normalized = change.updatedContent.replace(/\r\n|\n/g, eol);
            const fullRange = new vscode.Range(0, 0, Number.MAX_VALUE, Number.MAX_VALUE);
            edit.replace(change.uri, fullRange, normalized);
        }
        await vscode.workspace.applyEdit(edit);
        this.clear();
    }
}

export const migrationState = new MigrationStateService();
