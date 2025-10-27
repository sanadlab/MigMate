import * as vscode from 'vscode';
import { buildCliCommand, runCliTool } from '../services/cli';
import { logger } from '../services/logging';
import { API_KEY_ID } from '../constants';




export class MigrationExecutor {
    constructor(private context: vscode.ExtensionContext) {}

    public async executeMigration(srcLib: string, tgtLib: string, workspacePath: string): Promise<void> {
        logger.info(`Executing migration from '${srcLib}' to '${tgtLib}'`);
        const command = buildCliCommand(srcLib, tgtLib);

        const env: NodeJS.ProcessEnv = {};
        const openaiApiKey = await this.context.secrets.get(API_KEY_ID.OPENAI);
        if (openaiApiKey) {
            env.OPENAI_API_KEY = openaiApiKey;
        }

        await vscode.workspace.saveAll();
        await runCliTool(command, workspacePath, env);
        logger.info('CLI migration completed');
    }
}
