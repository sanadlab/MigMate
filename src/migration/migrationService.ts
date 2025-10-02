import * as vscode from 'vscode';
import { getLibrariesFromRequirements, getSourceLibrary, getTargetLibrary } from '../services/librariesApi';
import { checkTestResults, showTestResultsDetail } from '../services/testResults';
import { logger } from '../services/logging';
import { telemetryService } from '../services/telemetry';
import { EnvironmentManager } from './environmentManager';
import { FileProcessor } from './fileProcessor';
import { MigrationExecutor } from './migrationExecutor';
import { PreviewManager } from './previewManager';



export class MigrationService {
    private environmentManager: EnvironmentManager;
    private fileProcessor: FileProcessor;
    private migrationExecutor: MigrationExecutor;
    private previewManager: PreviewManager;

    constructor(private context: vscode.ExtensionContext) {
        this.environmentManager = new EnvironmentManager();
        this.fileProcessor = new FileProcessor();
        this.migrationExecutor = new MigrationExecutor();
        this.previewManager = new PreviewManager();
    }

    public async runMigration(hoverLibrary?: string): Promise<void> {
        logger.info('Migration process started');
        telemetryService.sendTelemetryEvent('migrationStarted', { trigger: hoverLibrary ? 'hover' : 'commandPalette' });

        try {
            const workspacePath = this.getWorkspacePath();
            const { srcLib, tgtLib } = await this.selectLibraries(hoverLibrary);
            const tempDir = await this.environmentManager.createTempDirectory();
            try {
                // // Copy the files over to temp directory
                const { pythonFiles, requirementsFiles } = await this.fileProcessor.findPythonFiles(workspacePath);
                this.fileProcessor.copyToTempDir(
                    [...pythonFiles, ...requirementsFiles],
                    workspacePath,
                    tempDir
                );
                this.environmentManager.initGitRepository(tempDir);
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
                const changes = this.fileProcessor.compareFiles(pythonFiles, workspacePath, tempDir);
                await this.previewManager.showChanges(changes, srcLib, tgtLib);
                this.environmentManager.saveTempDirPath(this.context, tempDir);
                logger.info('Migration process completed successfully');
            } catch (error) {
                logger.error('Error during migration process', error as Error);
                throw error; // temp dir won't be cleaned if migration fails --> check test logs
            }
        } catch (error) {
            const err = error as Error;
            logger.error('Migration failed', err);
            telemetryService.sendTelemetryErrorEvent('migrationError', { error: err.message });
            vscode.window.showErrorMessage(`Migration failed: ${err.message}`);
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
