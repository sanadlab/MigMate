import * as vscode from 'vscode';
import { execSync, exec } from 'child_process';
import { logger } from '../services/logging';



export class EnvironmentManager {
    // // Various git commands
    public initGitRepository(dir: string): void { // only use for temp --> maybe repurpose as option during direct?
        try {
            logger.info('Initializing git repository in directory');
            execSync('git init', { cwd: dir });
            execSync('git add .', { cwd: dir });
            execSync('git commit -m "Initial state for migration"', { cwd: dir });
            logger.info('Git repository initialized successfully');
        } catch (error) {
            const err = error as Error;
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
        // logger.info(`Saved results path to workspace state: ${resultsDir}`);
    }
}
