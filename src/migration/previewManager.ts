import * as vscode from 'vscode';
import * as path from 'path';
import { migrationState, MigrationChange, DiffHunk } from './migrationState';
import { configService } from '../services/config';
import { telemetryService } from '../services/telemetry';
import { logger } from '../services/logging';
import { MigrationWebview } from './migrationWebview';
import { DiffUtils } from './diffUtils';
import { CONFIG } from '../constants';



interface AppliedChange {
    filePath: string;
    appliedHunks: number;
    totalHunks: number;
}

interface PreviewStrategy {
    showChanges(srcLib: string, tgtLib: string): Promise<AppliedChange[] | void>;
}

export class PreviewManager {
    private strategies: Map<string, PreviewStrategy> = new Map();

    constructor() {
        this.strategies.set('Refactor Preview', new RefactorPreviewStrategy());
        this.strategies.set('Webview', new WebviewPreviewStrategy(new MigrationWebview()));
    }

    public async showChanges(changes: Omit<MigrationChange, 'hunks'>[], srcLib: string, tgtLib: string): Promise<void> {
        if (changes.length === 0) {
            logger.info('No changes were detected during migration');
            vscode.window.showInformationMessage('No changes were detected during migration.');
            return;
        }
        migrationState.loadChanges(changes);

        // // Show preview based on mode selected in config
        const previewMode = configService.get<string>(CONFIG.PREVIEW_STYLE, 'Webview');
        const strategy = this.strategies.get(previewMode);
        logger.info(`Using preview mode: ${previewMode}`);

        if (strategy) {
            const result = await strategy.showChanges(srcLib, tgtLib);
            if (result && Array.isArray(result)) { // only for Refactor Preview (calculate accepted changes)
                const appliedChanges = result;
                const totalApplied = appliedChanges.reduce((sum, change) => sum + change.appliedHunks, 0);
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
            logger.error(`Unrecognized preview style: ${previewMode}`);
            vscode.window.showErrorMessage("Unrecognized preview style. Please check plugin configuration.");
        }
    }
}

export class WebviewPreviewStrategy implements PreviewStrategy {
    constructor(private migrationWebview: MigrationWebview) {}
    async showChanges(srcLib: string, tgtLib: string): Promise<void> {
        telemetryService.sendTelemetryEvent('migrationPreview', { style: 'webview' });
        await this.migrationWebview.showPreview(migrationState.getChanges(), srcLib, tgtLib);
    }
}

export class RefactorPreviewStrategy implements PreviewStrategy {
    async showChanges(srcLib: string, tgtLib: string): Promise<AppliedChange[] | undefined> {
        telemetryService.sendTelemetryEvent('migrationPreview', { style: 'refactor' });
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
            const uri = change.uri;
            const doc = await vscode.workspace.openTextDocument(uri);
            const eol = DiffUtils.getDocumentEOL(doc);
            const hunks = migrationState.getHunks(change.uri);
            const processedHunkIds = new Set<number>();

            for (const hunk of hunks) {
                // // Skip hunks that were handled as part of a pair
                if (processedHunkIds.has(hunk.id)) {continue;}
                const pairedHunk = DiffUtils.findPairedHunk(hunk, hunks);

                // // Handle replacement case
                if (pairedHunk) {
                    const removalHunk = hunk.type === 'removed' ? hunk : pairedHunk;
                    const additionHunk = hunk.type === 'added' ? hunk : pairedHunk;
                    const range = new vscode.Range(
                        new vscode.Position(removalHunk.originalStartLine, 0),
                        new vscode.Position(removalHunk.originalStartLine + removalHunk.lines.length, 0)
                    );
                    const newText = DiffUtils.getReplacementText(additionHunk, doc);
                    const metadata: vscode.WorkspaceEditEntryMetadata = {
                        label: `Replace '${migrationState.cleanString(removalHunk.lines[0]).substring(0, 15)}...' with '${migrationState.cleanString(additionHunk.lines[0]).substring(0, 15)}...'`,
                        description: `Lines ${removalHunk.originalStartLine + 1} - ${removalHunk.originalStartLine + removalHunk.lines.length}`,
                        needsConfirmation: true,
                    };
                    edit.replace(change.uri, range, newText, metadata);
                    processedHunkIds.add(hunk.id);
                    processedHunkIds.add(pairedHunk.id);
                }
                // // Standalone add/remove case
                else {
                    // logger.info(`Processing standalone hunk: ${JSON.stringify(currentHunk.type)}`);
                    migrationState.handleSingleHunk(edit, change.uri, hunk, eol);
                    processedHunkIds.add(hunk.id);
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
                if (beforeText === afterContent) {continue;} // skip file if before & after match (no changes)

                // // Track analyzed hunks
                const processedAnalysisHunks = new Set<number>();
                let appliedOperationCount = 0;
                let totalOperationsInFile = 0;

                for (const hunk of hunks) {
                    if (processedAnalysisHunks.has(hunk.id)) {console.log(`  Skipping already processed hunk ${hunk.id}`); continue;}
                    console.log(`  Processing hunk ID ${hunk.id}, type: ${hunk.type}, lines: ${hunk.lines.length}`);
                    let wasApplied = false;
                    const pairedHunk = DiffUtils.findPairedHunk(hunk, hunks);

                    // // Part of a replacement
                    if (pairedHunk) {
                        console.log(`  Hunk ${hunk.id} is paired with ${pairedHunk.id}`);
                        const removalHunk = hunk.type === 'removed' ? hunk : pairedHunk;
                        const additionHunk = hunk.type === 'added' ? hunk : pairedHunk;
                        const removalApplied = !DiffUtils.isHunkApplied(removalHunk, beforeText, afterContent);
                        const additionApplied = DiffUtils.isHunkApplied(additionHunk, beforeText, afterContent);
                        console.log(`  Paired hunk check: remove=${removalApplied}, add=${additionApplied}`);
                        if (removalApplied && additionApplied) {
                            wasApplied = true;
                            logger.info(`Detected applied replacement at line ${hunk.originalStartLine + 1}`);
                        }
                        processedAnalysisHunks.add(pairedHunk.id);
                    }
                    // // Standalone change
                    else {
                        wasApplied = DiffUtils.isHunkApplied(hunk, beforeText, afterContent);
                        console.log(`  Standalone hunk check: applied=${wasApplied}`);
                        if (wasApplied) {
                            logger.info(`Detected applied standalone ${hunk.type} at line ${hunk.originalStartLine + 1}`);
                            appliedOperationCount++;
                        }
                    }

                    if (wasApplied) {
                        appliedOperationCount++;
                    }
                    processedAnalysisHunks.add(hunk.id);
                    totalOperationsInFile++;
                }
                console.log(`  Final count: ${appliedOperationCount} operations applied`);
                console.log(`  Total: ${totalOperationsInFile} operations possible`);

                if (appliedOperationCount > 0) {
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
        migrationState.clear();
        return appliedChanges;
    }
}
