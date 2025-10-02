import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { logger } from '../services/logging';



export class EnvironmentManager { // maybe have a temp and regular version?
    public async createTempDirectory(): Promise<string> {
        const tempDir = path.join(os.tmpdir(), `libmig-preview-${Date.now()}`);
        logger.info(`Creating temporary directory: ${tempDir}`);
        fs.mkdirSync(tempDir, { recursive: true });
        return tempDir;
    }

    public initGitRepository(tempDir: string): void {
        try {
            logger.info('Initializing git repository in temporary directory');
            execSync('git init', { cwd: tempDir });
            execSync('git add .', { cwd: tempDir });
            execSync('git commit -m "Initial state for migration"', { cwd: tempDir });
            logger.info('Git repository initialized successfully');
        } catch (error) {
            const err = error as Error; // temp dir won't be cleaned if error occurs
            logger.error('Failed to initialize git repository:', err);
            throw new Error('Failed to initialize git for migration. Please ensure git is installed and in your PATH.');
        }
    }

    public cleanupTempDirectory(tempDir: string): void {
        try {
            logger.info(`Cleaning up temporary directory: ${tempDir}`);
            fs.rmSync(tempDir, { recursive: true, force: true });
            logger.info('Temporary directory cleaned up successfully');
        } catch (error) {
            const err = error as Error; // temp dir won't be cleaned if error occurs
            logger.warn(`Failed to clean up temporary directory: ${err.message}`);
        }
    }

    public saveResultsPath(context: vscode.ExtensionContext, resultsDir: string): void {
        context.workspaceState.update('lastMigrationResults', resultsDir);
        logger.info(`Saved results path to workspace state: ${resultsDir}`);
    }
}
