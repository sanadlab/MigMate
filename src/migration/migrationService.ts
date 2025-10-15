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
import { MigrationChange } from './migrationState';



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

        this.activeMigration = true;
        logger.info('Migration process started');
        telemetryService.sendTelemetryEvent('migrationStarted', { trigger: hoverLibrary ? 'hover' : 'commandPalette' });

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Library Migration",
            cancellable: false // check this
        }, async (progress) => {
            try {
                progress.report({ message: "Initializing...", increment: 5 });
                const workspacePath = this.getWorkspacePath();

                progress.report({ message: "Selecting libraries...", increment: 5 });
                const { srcLib, tgtLib } = await this.selectLibraries(hoverLibrary);

                const useTempDirectory = configService.get<boolean>('options.useTempDirectory');
                logger.info(`Migration mode: ${useTempDirectory ? 'Temp' : 'Direct'}`);
                if (useTempDirectory) {
                    await this.runTempMigration(workspacePath, srcLib, tgtLib, progress);
                } else {
                    await this.runDirectMigration(workspacePath, srcLib, tgtLib, progress);
                }
                progress.report({ message: "Done.", increment: 10 });
            } catch (error) {
                const err = error as Error;
                logger.error('Migration failed', err);
                telemetryService.sendTelemetryErrorEvent('migrationError', { error: err.message });
                vscode.window.showErrorMessage(`Migration failed: ${err.message}`);
            }
            finally {
                this.activeMigration = false;
            }
        });
    }

    private async runTempMigration(workspacePath: string, srcLib: string, tgtLib: string, progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
        const tempDir = await this.environmentManager.createTempDirectory();
        try {
            // // Copy the files over to temp directory
            progress.report({ message: "Copying files...", increment: 20 });
            const { pythonFiles, requirementsFiles } = await this.fileProcessor.findPythonFiles(workspacePath);
            this.fileProcessor.copyToTempDir(
                [...pythonFiles, ...requirementsFiles],
                workspacePath,
                tempDir
            );
            this.environmentManager.initGitRepository(tempDir); // check this
            // // Perform the migration and check for test failures
            progress.report({ message: `Migrating from ${srcLib} to ${tgtLib}...`, increment: 30 });
            await this.migrationExecutor.executeMigration(srcLib, tgtLib, tempDir);
            progress.report({ message: "Checking test results...", increment: 10 });
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
            progress.report({ message: "Analyzing changes...", increment: 10 });
            const changes = this.fileProcessor.compareFiles(pythonFiles, workspacePath, tempDir);
            this.environmentManager.saveResultsPath(this.context, tempDir);
            progress.report({ message: "Generating preview...", increment: 10 });
            await this.previewManager.showChanges(changes, srcLib, tgtLib);
            logger.info('Migration process completed successfully (temp)');
            telemetryService.sendTelemetryEvent('migrationCompleted', { source: srcLib, target: tgtLib, mode: 'temp', changesFound: changes.length.toString() });
        } catch (error) {
            logger.error('Error during migration process (temp)', error as Error);
            throw error; // temp dir won't be cleaned if migration fails --> check test logs
        }
    }

    private async runDirectMigration(workspacePath: string, srcLib: string, tgtLib: string, progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
        logger.info(`Running migration directly on workspace: ${workspacePath}`);
        try {
            // // Check for git repository in workspace (CLI also checks, but fails silently?)
            const isRepo = await this.environmentManager.checkGitRepository(workspacePath);
            if(!isRepo) {
                logger.error('No git repository found in workspace');
                throw new Error('Current workspace is not a Git repository. Please initialize Git first.');
            }

            // // Save Python filepaths before migration
            const { pythonFiles } = await this.fileProcessor.findPythonFiles(workspacePath);
            progress.report({ message: `Migrating from ${srcLib} to ${tgtLib}...`, increment: 30 });
            await this.migrationExecutor.executeMigration(srcLib, tgtLib, workspacePath);

            // // Check for test failures
            progress.report({ message: "Checking test results...", increment: 10 });
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

            // // Check output folder for saved files (start from later rounds) // check this
            const outputDir = path.join(workspacePath, '.libmig'); // check this
            const roundFolders = ['0-premig', '1-llmmig', '2-merge_skipped', '3-async_transform']; // consider making a constant, maybe use for config enum as well
            let migratedFilesDir: string | undefined;

            for (let i = roundFolders.length - 1; i >= 0; i--) {
                const folder = roundFolders[i];
                const potentialDir = path.join(outputDir, folder, 'files');
                if (fs.existsSync(potentialDir)) {
                    migratedFilesDir = potentialDir;
                    logger.info(`Found latest migration output at ${potentialDir}`);
                    break; // check this // not sure if subsequent CLI calls remove round folders and start fresh
                }
            }

            if (!migratedFilesDir) {
                    logger.warn(`Migrated files not found in ${outputDir}`);
                    vscode.window.showWarningMessage("Migrated files not found. Cannot show preview.");
                    await this.environmentManager.gitResetHard(workspacePath); // always perform git reset
                    return;
                }

            // // Restore original files // is this better than saving pre-mig content in memory?
            progress.report({ message: "Restoring workspace to original state...", increment: 20 });
            await this.environmentManager.gitResetHard(workspacePath);

            // // Compare original files against migrated copies
            progress.report({ message: "Analyzing changes...", increment: 10 });
            const changes = this.fileProcessor.compareFiles(pythonFiles, workspacePath, migratedFilesDir);
            console.log("File comparison:", changes);

            // // Save results and show preview
            this.environmentManager.saveResultsPath(this.context, outputDir);
            progress.report({ message: "Generating preview...", increment: 10 });
            await this.previewManager.showChanges(changes, srcLib, tgtLib);

            logger.info('Migration process completed successfully (direct)');
            telemetryService.sendTelemetryEvent('migrationCompleted', { source: srcLib, target: tgtLib, mode: 'direct', changesFound: changes.length.toString() });
        } catch (error) {
            logger.error('Error during migration process (direct)', error as Error);
            try {
                await this.environmentManager.gitResetHard(workspacePath);
                logger.info('Succesfully reset workspace after direct migration error');
            } catch (gitError) {
                logger.error('Failed to revert workspace after direct migration error');
            }
            throw error;
        }
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
