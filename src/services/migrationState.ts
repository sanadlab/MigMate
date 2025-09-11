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
        const diffResult = diff.diffLines(original, updated, { newlineIsToken: false });
        const hunks: DiffHunk[] = [];
        let currentLine = 0;
        let hunkId = 0;

        diffResult.forEach(part => {
            const lines = part.value.endsWith('\n') ? part.value.slice(0, -1).split('\n') : [part.value];
            const lineCount = lines.length;
            if (part.added) {
                hunks.push({ id: hunkId++, type: 'added', lines, originalStartLine: currentLine, status: 'pending' });
            } else if (part.removed) {
                hunks.push({ id: hunkId++, type: 'removed', lines, originalStartLine: currentLine, status: 'pending' });
                currentLine += lineCount;
            } else {
                currentLine += lineCount;
            }
        });
        return hunks;
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
