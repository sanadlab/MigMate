import * as vscode from 'vscode';
import * as path from 'path';
import { migrationState, MigrationChange, DiffHunk } from './migrationState';
import { configService } from '../services/config';
import { telemetryService } from '../services/telemetry';
import { codeLensProvider, InlineDiffProvider } from '../providers';
import { logger } from '../services/logging';
import { MigrationWebview } from './migrationWebview';



interface AppliedChange {
    filePath: string;
    appliedHunks: number;
    totalHunks: number;
}

export class PreviewManager {
    private inlineDiffProvider: InlineDiffProvider;
    private migrationWebview: MigrationWebview;

    constructor() {
        this.inlineDiffProvider = new InlineDiffProvider();
        this.migrationWebview = new MigrationWebview();
    }

    public async showChanges(changes: Omit<MigrationChange, 'hunks'>[], srcLib: string, tgtLib: string): Promise<void> {
        if (changes.length === 0) {
            logger.info('No changes were detected during migration');
            vscode.window.showInformationMessage('No changes were detected during migration.');
            return;
        }
        migrationState.loadChanges(changes);

        // // Show preview based on mode selected in config
        const previewMode = configService.get<string>('options.previewGrouping');
        logger.info(`Using preview mode: ${previewMode}`);

        if (previewMode === 'webview') {
            await this.migrationWebview.showPreview(migrationState.getChanges(), srcLib, tgtLib);
        } else if (previewMode === 'All at once') {
            const appliedChanges = await this.showGroupedPreview();
            console.log("Applied changes:", appliedChanges);
            if (appliedChanges) {
                const totalApplied = appliedChanges.reduce((sum, change) => sum + change.appliedHunks, 0);
                console.log(`Applied changes to ${totalApplied} hunks`);
                const totalOperations = appliedChanges.reduce((sum, change) => sum + change.totalHunks, 0);
                telemetryService.sendTelemetryEvent('migrationChangesApplied', {
                    source: srcLib,
                    target: tgtLib,
                    appliedOperationCount: totalApplied.toString(),
                    totalOperationCount: totalOperations.toString(),
                    fileCount: changes.length.toString(),
                    appliedFiles: appliedChanges.map(c => path.basename(c.filePath)).join(',')
                });
            }
        } else {
            this.showInlinePreview();
        }
    }

    private async showGroupedPreview(): Promise<AppliedChange[] | undefined> {
        telemetryService.sendTelemetryEvent('migrationPreview', { mode: 'grouped' });
        const edit = new vscode.WorkspaceEdit();
        const fileInfo = new Map<string, { eol: string; endsWithEol: boolean; lineCount: number }>();
        const loadedChanges = migrationState.getChanges();
        const pairedHunks = new Map<number, number>();

        logger.info(`Processing ${loadedChanges.length} files with changes for preview`);
        if (loadedChanges.length === 0) {
            vscode.window.showInformationMessage('No changes made during migration');
            return undefined;
        }

        // // Save content just before going to the preview
        const beforeContent = new Map<string, string>();
        for (const change of loadedChanges) {
            const uri = change.uri;
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                beforeContent.set(uri.fsPath, doc.getText());
            } catch (error) {
                logger.warn(`Failed to read content before applying changes: ${error}`);
            }
        }

        // // Convert the detected changes for use in Refactor Preview
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
                if (processedHunkIds.has(currentHunk.id)) {continue;} // doesn't stop the changes from being unchecked by default

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
                        pairedHunks.set(currentHunk.id, nextHunk.id);
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

        // // Apply changes and show preview
        const success = await vscode.workspace.applyEdit(edit, { isRefactoring: true });
        if (!success) {
            logger.warn("User cancelled migration, or preview failed to apply.");
            migrationState.clear();
            return undefined;
        }
        await new Promise(resolve => setTimeout(resolve, 200)); // wait for file sync

        // // Check applied changes against initial
        logger.info("Analyzing applied changes for telemetry...");
        const appliedChanges: AppliedChange[] = [];
        for (const change of loadedChanges) {
            const uri = change.uri;
            const filePath = uri.fsPath;
            const hunks = migrationState.getHunks(uri);
            console.log(`Analyzing file: ${path.basename(filePath)} with ${hunks.length} hunks`);
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                const afterContent = doc.getText();
                const beforeText = beforeContent.get(filePath) ?? '';
                console.log(`  Content comparison: before ${beforeText.length} chars, after ${afterContent.length} chars`);
                console.log(`  Content identical? ${beforeText === afterContent}`);
                if (beforeText === afterContent) {continue;} // skip file if before & after match

                // // Track isolated by file
                const pairedHunksForFile = new Map<number, number>();
                const processedBuildHunks = new Set<number>();
                for (let i = 0; i < hunks.length; i++) {
                    const currentHunk = hunks[i];
                    if (processedBuildHunks.has(currentHunk.id)) {continue;}
                    if (currentHunk.type === 'removed' && i + 1 < hunks.length) {
                        const nextHunk = hunks[i + 1];
                        if (nextHunk.type === 'added' && nextHunk.originalStartLine === currentHunk.originalStartLine) {
                            pairedHunksForFile.set(currentHunk.id, nextHunk.id);
                            processedBuildHunks.add(currentHunk.id);
                            processedBuildHunks.add(nextHunk.id);
                        }
                    }
                }

                // // Track analyzed hunks
                const processedAnalysisHunks = new Set<number>();
                let appliedOperationCount = 0;
                console.log(`  Found ${pairedHunksForFile.size} paired hunks in file`);

                for (const hunk of hunks) {
                    if (processedAnalysisHunks.has(hunk.id)) {console.log(`  Skipping already processed hunk ${hunk.id}`); continue;}
                    console.log(`  Processing hunk ID ${hunk.id}, type: ${hunk.type}, lines: ${hunk.lines.length}`);
                    let wasApplied = false;
                    const pairedId = pairedHunksForFile.get(hunk.id);

                    // // Part of a replacement
                    if (pairedId) {
                        console.log(`  Hunk ${hunk.id} is paired with ${pairedId}`);
                        const pairedHunk = hunks.find(h => h.id === pairedId);
                        if (pairedHunk) {
                            const firstApplied = this.isHunkApplied(hunk, beforeText, afterContent);
                            const secondApplied = this.isHunkApplied(pairedHunk, beforeText, afterContent);
                            console.log(`  Paired hunk check: first=${firstApplied}, second=${secondApplied}`);
                            if (firstApplied && secondApplied) {
                                wasApplied = true;
                                logger.info(`Detected applied replacement at line ${hunk.originalStartLine + 1}`);
                            }
                            processedAnalysisHunks.add(pairedHunk.id);
                        } else {console.log(`  WARNING: Could not find paired hunk with ID ${pairedId}`);}
                    }
                    // // Standalone change
                    else {
                        wasApplied = this.isHunkApplied(hunk, beforeText, afterContent);
                        console.log(`  Standalone hunk check: applied=${wasApplied}`);
                        if (wasApplied) {
                            logger.info(`Detected applied ${hunk.type} at line ${hunk.originalStartLine + 1}`);
                        }
                    }

                    if (wasApplied) {
                        appliedOperationCount++;
                    }
                    processedAnalysisHunks.add(hunk.id);
                }
                console.log(`  Final count: ${appliedOperationCount} operations applied`);

                if (appliedOperationCount > 0) {
                    const totalOperationsInFile = hunks.length - pairedHunksForFile.size;
                    logger.info(`Detected ${appliedOperationCount}/${totalOperationsInFile} applied operations in ${path.basename(filePath)}`);
                    appliedChanges.push({
                        filePath,
                        appliedHunks: appliedOperationCount,
                        totalHunks: totalOperationsInFile
                    });
                }
            } catch (error) {
                logger.warn(`Failed to analyze changes for ${path.basename(filePath)}: ${error}`);
            }
        }

        // // Clean everything up
        migrationState.clear();
        codeLensProvider.refresh();
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            this.inlineDiffProvider.clearDecorations(editor);
        }
        return appliedChanges;
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

    private isHunkApplied(hunk: DiffHunk, beforeContent: string, afterContent: string): boolean {
        const hunkContent = hunk.lines.join('\n'); // check this // add normalization for EOL?
        if (hunk.type === 'added') {
            const normalizedAfterContent = afterContent.replace(/\r\n/g, '\n');
            return normalizedAfterContent.includes(hunkContent);
        }
        if (hunk.type === 'removed') {
            const normalizedBeforeContent = beforeContent.replace(/\r\n/g, '\n');
            const normalizedAfterContent = afterContent.replace(/\r\n/g, '\n');
            return normalizedBeforeContent.includes(hunkContent) && !normalizedAfterContent.includes(hunkContent);
            // // // Get the surrounding lines
            // const beforeLines = beforeContent.split('\n');
            // const contextBefore = beforeLines[hunk.originalStartLine - 1] || '';
            // const contextAfter = beforeLines[hunk.originalStartLine + hunk.lines.length] || '';
            // if (contextBefore || contextAfter) {
            //     const pattern = [contextBefore, ...hunk.lines, contextAfter].filter(line => line).join('\n');
            //     return !afterContent.includes(pattern);
            // }
            // return !afterContent.includes(hunkContent);
        }
        return false;
    }
}
