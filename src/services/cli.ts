import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { configService } from './config';
import { logger } from './logging';



// // Run target command in CLI
export function runCliTool(command: string, cwd: string) {
    logger.show();
    logger.info(`Running command in ${cwd}: ${command}`);

    // // add timeout?
    // const startTime = Date.now();

    // check this
    return new Promise<void>((resolve, reject) => {
        const [cmd, ...args] = command.split(' ');
        const child = spawn(cmd, args, { cwd, shell: true });

        child.stdout.on('data', (data: Buffer) => {
            logger.append(data.toString());
        });
        child.stderr.on('data', (data: Buffer) => {
            logger.append(data.toString());
        });
        child.on('close', (code) => {
            logger.info(`Command finished with exit code: ${code}`);
            if (code === 0) {
                vscode.window.showInformationMessage('LibMig process completed successfully');
                resolve();
            } else {
                const err = new Error(`Process failed with exit code ${code}`);
                logger.error(err.message, err);
                vscode.window.showErrorMessage(err.message);
                reject(err);
            }
        });
        child.on('error', (err) => {
            logger.error(`Failed to start process: ${err.message}`, err);
            vscode.window.showErrorMessage(`Failed with error: ${err.message}`);
            reject(err);
        });
    });
}

export function buildCliCommand(srcLib: string, tgtLib: string): string {
    // // New construction of CLI command (WIP)
    const commandParts = ['libmig', srcLib, tgtLib];

    // // Only add flags that differ from their default value
    const addFlag = (key: string, cliFlag: string) => {
        const details = configService.inspect(key);
        const currentValue = configService.get(key);

        if (details && currentValue !== undefined && currentValue !== details.defaultValue) { // skip if undefined or default value
            if (typeof currentValue === 'boolean') {
                if (currentValue === true) { // only add True booleans
                    commandParts.push(cliFlag);
                }
            }
            else if (currentValue !== '') { // ignore empty strings
                if (Array.isArray(currentValue) && currentValue.length > 0) { // currently only for migrationRounds // check this to see Integer vs Array
                    commandParts.push(`${cliFlag}=${currentValue.join(',')}`);
                }
                else if (!Array.isArray(currentValue)) { // check if this is fine for all string config options
                    commandParts.push(`${cliFlag}=${currentValue}`);
                }
            }
        }
    };

    // // Add all of the relevant flags
    addFlag('flags.pythonVersion', '--python-version');
    addFlag('flags.forceRerun', '--force-rerun');
    addFlag('flags.smartSkipTests', '--smart-skip-tests');
    addFlag('flags.maxFileCount', '--max-files');
    addFlag('flags.LLMClient', '--llm');
    addFlag('flags.migrationRounds', '--rounds');
    addFlag('flags.repositoryName', '--repo');
    addFlag('flags.testSuitePath', '--test-root');
    addFlag('flags.outputPath', '--output-path');
    addFlag('flags.requirementFilePath', '--requirements-file-path');

    return commandParts.join(' ');
}
