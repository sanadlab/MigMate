import * as vscode from 'vscode';

export interface MigrationChange {
    uri: vscode.Uri,
    originalContent: string;
    updatedContent: string;
}

class MigrationStateService {
    private changes: Map<string, MigrationChange> = new Map();

    loadChanges(newChanges: MigrationChange[]) {
        this.changes.clear();
        newChanges.forEach(change => {
            this.changes.set(change.uri.toString(), change);
        });
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
