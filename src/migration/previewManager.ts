import * as vscode from 'vscode';
import { migrationState, MigrationChange } from '../services/migrationState';
import { configService } from '../services/config';
import { telemetryService } from '../services/telemetry';
import { codeLensProvider, InlineDiffProvider } from '../providers';
import { logger } from '../services/logging';




export class PreviewManager {
    private inlineDiffProvider: InlineDiffProvider;

    constructor() {
        this.inlineDiffProvider = new InlineDiffProvider();
    }

    public async showChanges(changes: Omit<MigrationChange, 'hunks'>[], srcLib: string, tgtLib: string): Promise<void> {
        if (changes.length === 0) {
            logger.info('No changes were detected during migration');
            vscode.window.showInformationMessage('No changes were detected during migration.');
            return;
        }

        migrationState.loadChanges(changes);
        telemetryService.sendTelemetryEvent('migrationCompleted', { source: srcLib, target: tgtLib });

        // // Show preview based on mode selected in config
        const previewMode = configService.get<string>('flags.previewGrouping');
        logger.info(`Using preview mode: ${previewMode}`);

        if (previewMode === 'All at once') {
            await this.showGroupedPreview();
        } else {
            this.showInlinePreview();
        }
    }

    private async showGroupedPreview(): Promise<void> {
        telemetryService.sendTelemetryEvent('migrationPreview', { mode: 'grouped' });
        const edit = new vscode.WorkspaceEdit();
        const fileInfo = new Map<string, { eol: string; endsWithEol: boolean; lineCount: number }>();
        const loadedChanges = migrationState.getChanges();

        logger.info(`Processing ${loadedChanges.length} files with changes for preview`);
        if (loadedChanges.length === 0) {
            vscode.window.showInformationMessage('No changes made during migration');
            return;
        }

        for (const change of loadedChanges) {
            // // Keep track of EOL/EOF characters for each file being changed
            const key = change.uri.toString();
            if (!fileInfo.has(key)) {
                const doc = await vscode.workspace.openTextDocument(change.uri);
                const eol = doc.eol === vscode.EndOfLine.LF ? '\n' : '\r\n';
                fileInfo.set(key, {
                    eol,
                    endsWithEol: doc.getText().endsWith(eol),
                    lineCount: doc.lineCount
                });
            }
            const { eol, endsWithEol, lineCount } = fileInfo.get(key)!;

            // // Retrieve the hunks and sort the changes from bottom to top
            const hunks = migrationState.getHunks(change.uri);
            const processedHunkIds = new Set<number>();

            for (let i = 0; i < hunks.length; i++) {
                const currentHunk = hunks[i];
                if (processedHunkIds.has(currentHunk.id)) {continue;} // hopefully stops the changes from being unchecked by default

                // // Pair remove + added --> replacement
                if (currentHunk.type === 'removed' && i + 1 < hunks.length) {
                    const nextHunk = hunks[i + 1];
                    if (nextHunk.type === 'added' && nextHunk.originalStartLine === currentHunk.originalStartLine) {
                        const startPos = new vscode.Position(currentHunk.originalStartLine, 0);
                        const endPos = new vscode.Position(currentHunk.originalStartLine + currentHunk.lines.length, 0);
                        const range = new vscode.Range(startPos, endPos);
                        let newText = nextHunk.lines.join(eol);

                        // // Respect original file's trailing EOL
                        const afterLine = currentHunk.originalStartLine + currentHunk.lines.length;
                        const reachedEOF = afterLine >= lineCount;
                        if (reachedEOF) {
                            if (endsWithEol && !newText.endsWith(eol)) {
                                newText += eol;
                            } else if (!endsWithEol && newText.endsWith(eol)) {
                                newText = newText.replace(new RegExp(`${eol}$`), '');
                            }
                        } else {
                            if (nextHunk.lines.length > 0 && !newText.endsWith(eol)) {
                                newText += eol;
                            }
                        }

                        const metadata: vscode.WorkspaceEditEntryMetadata = {
                            label: `Replace '${migrationState.cleanString(currentHunk.lines[0]).substring(0, 15)}...' with '${migrationState.cleanString(nextHunk.lines[0]).substring(0, 15)}...'`,
                            description: `Lines ${currentHunk.originalStartLine + 1} - ${currentHunk.originalStartLine + currentHunk.lines.length}`,
                            needsConfirmation: true,
                        };
                        edit.replace(change.uri, range, newText, metadata);
                        processedHunkIds.add(currentHunk.id);
                        processedHunkIds.add(nextHunk.id);
                        continue;
                    }
                }

                // // Standalone add/remove
                if (!processedHunkIds.has(currentHunk.id)) {
                    // logger.info(`Processing standalone hunk: ${JSON.stringify(currentHunk.type)}`);
                    migrationState.handleSingleHunk(edit, change.uri, currentHunk, eol);
                }
            }
        }

        await vscode.workspace.applyEdit(edit, { isRefactoring: true });
        migrationState.clear();
        codeLensProvider.refresh();
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            this.inlineDiffProvider.clearDecorations(editor);
        }
    }

    private showInlinePreview(): void { // leave for now, might remove // check this
        telemetryService.sendTelemetryEvent('migrationPreview', { mode: 'inline' });
        vscode.window.visibleTextEditors.forEach(editor => {
            if (migrationState.getChange(editor.document.uri)) {
                this.inlineDiffProvider.showDecorations(editor);
            }
        });
        codeLensProvider.refresh();
    }
}
