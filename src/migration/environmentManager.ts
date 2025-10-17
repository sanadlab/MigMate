import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, exec } from 'child_process';
import { logger } from '../services/logging';
import { PLUGIN } from '../constants';



export class EnvironmentManager {
    // // Temp directory creation/deletion
    public async createTempDirectory(): Promise<string> {
        const tempDir = path.join(os.tmpdir(), `${PLUGIN}-preview-${Date.now()}`);
        logger.info(`Creating temporary directory: ${tempDir}`);
        fs.mkdirSync(tempDir, { recursive: true });
        return tempDir;
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

    // // Various git commands
    public initGitRepository(tempDir: string): void { // only use for temp
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

    public async checkGitRepository(path: string): Promise<boolean> {
        return new Promise((resolve) => {
            exec('git rev-parse --is-inside-work-tree', { cwd: path }, (error, stdout) => {
                if (error || stdout.trim() !== 'true') {
                    logger.warn(`Directory is not a git repository: ${path}`);
                    resolve(false);
                }
                resolve(true);
            });
        });
    }

    public async gitResetHard(path: string): Promise<void> {
        return new Promise((resolve, reject) => {
            exec('git reset --hard', { cwd: path }, (error, stdout, stderr) => {
                if (error) {
                    logger.error(`Failed to execute git reset: ${stderr}`);
                    reject(new Error('Failed to reset the workspace'));
                } else {
                    logger.info('Successfully reset workspace');
                    resolve();
                }
            });
        });
    }

    // // Misc.
    public saveResultsPath(context: vscode.ExtensionContext, resultsDir: string): void {
        context.workspaceState.update('lastMigrationResults', resultsDir);
        logger.info(`Saved results path to workspace state: ${resultsDir}`);
    }
}
