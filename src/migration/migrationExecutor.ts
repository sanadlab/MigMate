import * as vscode from 'vscode';
import { buildCliCommand, runCliTool } from '../services/cli';
import { logger } from '../services/logging';



export class MigrationExecutor {
    public async executeMigration(srcLib: string, tgtLib: string, workspacePath: string): Promise<void> {
        logger.info(`Executing migration from '${srcLib}' to '${tgtLib}' in ${workspacePath}`);
        const command = buildCliCommand(srcLib, tgtLib);
        await vscode.workspace.saveAll();
        await runCliTool(command, workspacePath);
        logger.info('Migration execution completed');
    }
}
