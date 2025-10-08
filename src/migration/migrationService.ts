import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getLibrariesFromRequirements, getSourceLibrary, getTargetLibrary } from '../services/librariesApi';
import { checkTestResults, showTestResultsDetail } from '../services/testResults';
import { logger } from '../services/logging';
import { telemetryService } from '../services/telemetry';
import { EnvironmentManager } from './environmentManager';
import { FileProcessor } from './fileProcessor';
import { MigrationExecutor } from './migrationExecutor';
import { PreviewManager } from './previewManager';
import { configService } from '../services/config';
import { MigrationChange } from '../services/migrationState';



export class MigrationService {
    private environmentManager: EnvironmentManager;
    private fileProcessor: FileProcessor;
    private migrationExecutor: MigrationExecutor;
    private previewManager: PreviewManager;
    private activeMigration: boolean = false;

    constructor(private context: vscode.ExtensionContext) {
        this.environmentManager = new EnvironmentManager();
        this.fileProcessor = new FileProcessor();
        this.migrationExecutor = new MigrationExecutor();
        this.previewManager = new PreviewManager();
    }

    public async runMigration(hoverLibrary?: string): Promise<void> {
        if (this.activeMigration) {
            logger.warn("Migration triggered while another migration is already running");
            vscode.window.showInformationMessage("A migration is already in progress.");
            return;
        }

        logger.info('Migration process started');
        telemetryService.sendTelemetryEvent('migrationStarted', { trigger: hoverLibrary ? 'hover' : 'commandPalette' });

        try {
            this.activeMigration = true;
            const workspacePath = this.getWorkspacePath();
            const { srcLib, tgtLib } = await this.selectLibraries(hoverLibrary);

            const useTempDirectory = configService.get<boolean>('options.useTempDirectory');
            logger.info(`Migration mode: ${useTempDirectory ? 'Temp' : 'Direct'}`);
            if (useTempDirectory) {
                await this.runTempMigration(workspacePath, srcLib, tgtLib);
            } else {
                await this.runDirectMigration(workspacePath, srcLib, tgtLib);
            }
        } catch (error) {
            const err = error as Error;
            logger.error('Migration failed', err);
            telemetryService.sendTelemetryErrorEvent('migrationError', { error: err.message });
            vscode.window.showErrorMessage(`Migration failed: ${err.message}`);
        }
        finally {
            this.activeMigration = false;
        }
    }

    private async runTempMigration(workspacePath: string, srcLib: string, tgtLib: string): Promise<void> {
        const tempDir = await this.environmentManager.createTempDirectory();
        try {
            // // Copy the files over to temp directory
            const { pythonFiles, requirementsFiles } = await this.fileProcessor.findPythonFiles(workspacePath);
            this.fileProcessor.copyToTempDir(
                [...pythonFiles, ...requirementsFiles],
                workspacePath,
                tempDir
            );
            this.environmentManager.initGitRepository(tempDir); // check this
            // // Perform the migration and check for test failures
            await this.migrationExecutor.executeMigration(srcLib, tgtLib, tempDir);
            const testResults = await checkTestResults(tempDir);
            if (testResults.hasFailures) {
                const viewDetailsAction = 'View Details';
                const response = await vscode.window.showWarningMessage(
                    `${testResults.failureCount} test${testResults.failureCount !== 1 ? 's' : ''} failed during migration.`,
                    viewDetailsAction
                );
                if (response === viewDetailsAction) {
                    showTestResultsDetail(testResults);
                }
            }
            // // Compare files and show preview
            const changes = this.fileProcessor.compareFiles(pythonFiles, workspacePath, tempDir, false);
            await this.previewManager.showChanges(changes, srcLib, tgtLib);
            this.environmentManager.saveResultsPath(this.context, tempDir);
            logger.info('Migration process completed successfully (temp)');
            telemetryService.sendTelemetryEvent('migrationCompleted', { source: srcLib, target: tgtLib, mode: 'temp', changesFound: changes.length.toString() });
        } catch (error) {
            logger.error('Error during migration process (temp)', error as Error);
            throw error; // temp dir won't be cleaned if migration fails --> check test logs
        }
    }

    private async runDirectMigration(workspacePath: string, srcLib: string, tgtLib: string): Promise<void> {
        logger.info(`Running migration directly on workspace: ${workspacePath}`);
        try {
            // // Save Python filepaths before migration
            const { pythonFiles, requirementsFiles } = await this.fileProcessor.findPythonFiles(workspacePath);
            await this.migrationExecutor.executeMigration(srcLib, tgtLib, workspacePath);

            // // Check for test failures
            const testResults = await checkTestResults(workspacePath);
            if (testResults.hasFailures) {
                const viewDetailsAction = 'View Details';
                const response = await vscode.window.showWarningMessage(
                    `${testResults.failureCount} test${testResults.failureCount !== 1 ? 's' : ''} failed during migration.`,
                    viewDetailsAction
                );
                if (response === viewDetailsAction) {
                    showTestResultsDetail(testResults);
                }
            }

            // // Check the unmodified copy under `.libmig/0-premig/files` folder
            const premigDir = path.join(workspacePath, '.libmig', '0-premig', 'files'); // check this once output folder config is fully implemented
            if (!fs.existsSync(premigDir)) {
                logger.warn(`Premigration backup directory not found at ${premigDir}`);
                vscode.window.showWarningMessage("Could not find backup files in output directory.");
                return;
            }

            // // Store migrated content in memory (WIP)
            const migratedContent = new Map<string, string>();
            for (const fileUri of pythonFiles) {
                try {
                    const filePath = fileUri.fsPath;
                    if (fs.existsSync(filePath)) {
                        migratedContent.set(filePath, fs.readFileSync(filePath, 'utf-8'));
                        // logger.info(`Stored migrated content for ${path.basename(filePath)}`);
                    }
                } catch (error) {
                    logger.warn(`Failed to read migrated content: ${error}`);
                }
            }

            // // Restore original files (WIP) // is this better than saving pre-mig content in memory?
            const restored = await this.restoreFromBackup(workspacePath);
            if (!restored) {
                logger.warn("Failed to restore original files");
                vscode.window.showWarningMessage("Failed to restore original files for preview.");
                return;
            }

            // // Compare files against stored content
            const changes: Omit<MigrationChange, 'hunks'>[] = [];
            for (const fileUri of pythonFiles) {
                const filePath = fileUri.fsPath;
                if (migratedContent.has(filePath)) {
                    try {
                        const doc = await vscode.workspace.openTextDocument(fileUri);
                        const originalContent = doc.getText();
                        const updatedContent = migratedContent.get(filePath)!;
                        if (originalContent !== updatedContent) {
                            changes.push({
                                uri: fileUri,
                                originalContent,
                                updatedContent
                            });
                        }
                    } catch (error) {
                        logger.warn(`Failed to build changes for ${fileUri.fsPath}: ${error}`);
                    }
                }
            }
            console.log("Changes:", changes);
            // // Save results and show preview
            this.environmentManager.saveResultsPath(this.context, path.join(workspacePath, '.libmig')); // consider renaming // check this
            await this.previewManager.showChanges(changes, srcLib, tgtLib);

            logger.info('Migration process completed successfully (direct)');
            telemetryService.sendTelemetryEvent('migrationCompleted', { source: srcLib, target: tgtLib, mode: 'direct', changesFound: changes.length.toString() });
        } catch (error) {
            logger.error('Error during migration process (direct)', error as Error);
            throw error;
        }
    }

    public async restoreFromBackup(workspacePath: string): Promise<boolean> {
        logger.info("Restoring files to pre-migration state...");
        const { pythonFiles } = await this.fileProcessor.findPythonFiles(workspacePath);

        // // Check the unmodified copies under `.libmig/0-premig/files` folder
        const premigDir = path.join(workspacePath, '.libmig', '0-premig', 'files'); // check this once output folder config is fully implemented
        if (!fs.existsSync(premigDir)) {
            logger.warn(`Premigration backup directory not found at ${premigDir}`);
            vscode.window.showErrorMessage("Could not find pre-migration backups to restore.");
            return false;
        }

        // // Create workspace edit for restoration
        const restoreEdit = new vscode.WorkspaceEdit();
        for (const fileUri of pythonFiles) {
            const relativePath = path.relative(workspacePath, fileUri.fsPath);
            const backupPath = path.join(premigDir, relativePath);
            if (fs.existsSync(backupPath)) {
                try {
                    const originalContent = fs.readFileSync(backupPath, 'utf-8');
                    const doc = await vscode.workspace.openTextDocument(fileUri);
                    const fullRange = new vscode.Range(
                        new vscode.Position(0, 0),
                        new vscode.Position(doc.lineCount, 0)
                    );
                    restoreEdit.replace(fileUri, fullRange, originalContent);
                } catch (error) {
                    logger.warn(`Failed to prepare restoration for ${fileUri.fsPath}: ${error}`);
                }
            }
        }

        // // Apply the edit
        const restored = await vscode.workspace.applyEdit(restoreEdit);
        if (restored) {
            logger.info("Successfully restored files to pre-migration state");
            // vscode.window.showInformationMessage("Files restored to pre-migration state."); // move this if restore becomes a standalone command
        } else {
            logger.error("Failed to restore files");
            vscode.window.showErrorMessage("Failed to restore files to pre-migration state.");
        }
        return restored;
    }

    private getWorkspacePath(): string {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            logger.error('No workspace folder is open');
            throw new Error('No workspace folder is open. Please open a project to run this command.');
        }
        const workspacePath = workspaceFolders[0].uri.fsPath;
        logger.info(`Using workspace path: ${workspacePath}`);
        return workspacePath;
    }

    private async selectLibraries(hoverLibrary?: string): Promise<{ srcLib: string, tgtLib: string }> {
        // // Get libraries from requirements file
        const libraries = await getLibrariesFromRequirements();
        if (libraries.length <= 0) {
            logger.warn('No libraries found in requirements file');
            vscode.window.showWarningMessage('No libraries found in requirements file.');
        }

        const srcLib = await getSourceLibrary(hoverLibrary, libraries);
        if (!srcLib) {
            logger.warn('Migration cancelled: No source library selected');
            telemetryService.sendTelemetryEvent('migrationCancelled', { reason: 'noSourceLibrary' });
            throw new Error('No source library selected.');
        }

        const tgtLib = await getTargetLibrary(srcLib);
        if (!tgtLib) {
            logger.warn('Migration cancelled: No target library selected');
            telemetryService.sendTelemetryEvent('migrationCancelled', { reason: 'noTargetLibrary' });
            throw new Error('No target library selected.');
        }

        logger.info(`Selected libraries for migration: '${srcLib}' to '${tgtLib}'`);
        return { srcLib, tgtLib };
    }
}
