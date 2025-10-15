import * as vscode from 'vscode';
import * as diff from 'diff';
import { DiffUtils } from './diffUtils';

export interface MigrationChange {
    uri: vscode.Uri,
    originalContent: string;
    updatedContent: string;
    hunks: DiffHunk[];
}

export interface DiffHunk {
    id: number;
    type: 'added' | 'removed';
    lines: string[];
    originalStartLine: number;
    pairedHunkId?: number;
    contextBefore?: string;
    contextAfter?: string;
    hashKey?: string; // should help as a unique ID on top of integer 'id'
    // status?: 'pending' | 'accepted' | 'rejected'; // unused
    // importance?: 'critical' | 'high' | 'medium' | 'low';
    // migrationContext?: string; // kind of migration change (import, function call, etc.) // check this --> see how CLI tool classifies
    // description?: string;
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
        // // Normalize the line endings
        const originalLines = original.replace(/\r\n/g, '\n').split('\n');
        const updatedLines = updated.replace(/\r\n/g, '\n').split('\n');
        const diffResult = diff.diffArrays(originalLines, updatedLines); // check this, compare lines vs arrays

        const hunks: DiffHunk[] = [];
        let originalLine = 0;
        let id = 0;
        let lastRemovedHunk: DiffHunk | null = null;
        for (const part of diffResult) {
            const lines = part.value as string[];
            if (part.removed) {
                const contextBefore = originalLines.slice(Math.max(0, originalLine - 3), originalLine).join('\n');
                const contextAfter = originalLines.slice(originalLine + lines.length, Math.min(originalLines.length, originalLine + lines.length + 3)).join('\n');
                const removedHunk: DiffHunk = {
                    id: id++,
                    type: 'removed' as const,
                    lines: lines,
                    originalStartLine: originalLine,
                    contextBefore: contextBefore,
                    contextAfter: contextAfter,
                    hashKey: this.createHunkHash(lines, contextBefore, contextAfter)
                };
                hunks.push(removedHunk);
                originalLine += lines.length;
                lastRemovedHunk = removedHunk;
            }
            else if (part.added) {
                const start = lastRemovedHunk ? lastRemovedHunk.originalStartLine : originalLine;
                const contextBefore = originalLines.slice(Math.max(0, start - 3), start).join('\n');
                const contextAfter = originalLines.slice(start, Math.min(originalLines.length, start + 3)).join('\n');
                const addedHunk: DiffHunk = {
                    id: id++,
                    type: 'added' as const,
                    lines: lines,
                    originalStartLine: start,
                    pairedHunkId: lastRemovedHunk ? lastRemovedHunk.id : undefined,
                    contextBefore: contextBefore,
                    contextAfter: contextAfter,
                    hashKey: this.createHunkHash(lines, contextBefore, contextAfter)
                };
                if (lastRemovedHunk) {
                    lastRemovedHunk.pairedHunkId = addedHunk.id;
                }
                hunks.push(addedHunk);
                lastRemovedHunk = null;
            }
            else {
                originalLine += lines.length;
                lastRemovedHunk = null;
            }
        }
        return hunks;
    }

    public handleSingleHunk(edit: vscode.WorkspaceEdit, uri: vscode.Uri, hunk: DiffHunk, eol: string = '\n', confirm: boolean = true) {
        if (hunk.type === 'removed') {
            const startPos = new vscode.Position(hunk.originalStartLine, 0);
            const endPos = new vscode.Position(hunk.originalStartLine + hunk.lines.length, 0);
            const range = new vscode.Range(startPos, endPos);

            edit.delete(uri, range, {
                label: `Remove '${this.cleanString(hunk.lines[0]).substring(0, 20)}${hunk.lines.length > 1 ? '...' : ''}'`,
                description: `Lines ${hunk.originalStartLine + 1} - ${hunk.originalStartLine + hunk.lines.length}`,
                needsConfirmation: confirm,
            });
        }
        else if (hunk.type === 'added') {
            const pos = new vscode.Position(hunk.originalStartLine, 0);
            let insertText = hunk.lines.join(eol);

            // // Case where EOF tries to add empty string
            if (hunk.lines.length === 1 && hunk.lines[0] === '' && hunk.originalStartLine >= 0) {
                insertText = eol;
            }

            edit.insert(uri, pos, insertText, {
                label: `Add '${this.cleanString(hunk.lines[0]).substring(0, 20)}${hunk.lines.length > 1 ? '...' : ''}'`,
                description: `After line ${hunk.originalStartLine}`,
                needsConfirmation: confirm,
            });
        }
    }

    private createHunkHash(lines: string[], before: string, after: string): string {
        const content = `${before}\n${lines.join('\n')}\n${after}`;
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0;
        }
        return hash.toString(36);
    }

    public cleanString(str: string): string {
        if (!str) {return '';}
        return str.replace(/\r?\n|\r/g, '').trim();
    }

    public getHunks(uri: vscode.Uri): DiffHunk[] {
        return this.changes.get(uri.toString())?.hunks || [];
    }


    public getChanges(): MigrationChange[] {
        return Array.from(this.changes.values());
    }

    public getChange(uri: vscode.Uri): MigrationChange | undefined {
        return this.changes.get(uri.toString());
    }

    public clear() {
        this.changes.clear();
    }
}

export const migrationState = new MigrationStateService();
