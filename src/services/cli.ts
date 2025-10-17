import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { configService } from './config';
import { logger } from './logging';
import { CONFIG, PLUGIN_TITLE } from '../constants';



// // Run target command in CLI
export function runCliTool(command: string, cwd: string, env: NodeJS.ProcessEnv = {}) {
    logger.show();
    logger.info(`Running command in ${cwd}: ${command}`);

    // // add timeout?
    // const startTime = Date.now();

    // check this
    return new Promise<void>((resolve, reject) => {
        const [cmd, ...args] = command.split(' ');
        const migrationEnv = { ...process.env, ...env };
        const child = spawn(cmd, args, { cwd, shell: true, env: migrationEnv });

        child.stdout.on('data', (data: Buffer) => {
            logger.append(data.toString());
        });
        child.stderr.on('data', (data: Buffer) => {
            logger.append(data.toString());
        });
        child.on('close', (code) => {
            logger.info(`Command finished with exit code: ${code}`);
            if (code === 0) {
                vscode.window.showInformationMessage(`${PLUGIN_TITLE} process completed successfully`);
                resolve();
            } else {
                const err = new Error(`${PLUGIN_TITLE} process failed with exit code ${code}`);
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
    const commandParts = ['libmig', srcLib, tgtLib];

    // // Only add flags that differ from their default value
    const addFlag = (key: string, cliFlag: string) => {
        const details = configService.inspect(key);
        const currentValue = configService.get(key);

        // Skip if flag is undefined or default value, ignore empty strings
        if (details && currentValue !== undefined && currentValue !== details.defaultValue) {
            if (typeof currentValue === 'boolean') {
                commandParts.push(cliFlag); // Apparently the boolean flags are toggles --> don't take values
            }
            else if (currentValue !== '') {
                if (Array.isArray(currentValue) && currentValue.length > 0) { // currently only for migrationRounds
                    currentValue.forEach(subValue => {
                        commandParts.push(`${cliFlag}=${subValue}`);
                    });
                }
                else if (!Array.isArray(currentValue)) { // check if this is fine for all string config options
                    commandParts.push(`${cliFlag}=${currentValue}`);
                }
            }
        }
    };

    const addFlagAlways = (key: string, cliFlag: string) => {
        const currentValue = configService.get(key);
        if (currentValue !== undefined && currentValue !== '') {
            commandParts.push(`${cliFlag}=${currentValue}`);
        }
    };

    // // Add all of the relevant flags
    addFlag(CONFIG.REPO_NAME, '--repo'); // string, default=None
    addFlag(CONFIG.REQ_FILE, '--requirements-file-path'); // string (path), default='.'
    addFlag(CONFIG.TEST_ROOT, '--test-root'); // string (path), default=None --> checks './requirements.txt'
    addFlag(CONFIG.OUTPUT_PATH, '--output-path'); // string (path), default='.libmig'
    addFlag(CONFIG.MAX_FILES, '--max-files'); // int, default=20
    addFlag(CONFIG.PYTHON_VERSION, '--python-version'); // string, default=None
    addFlag(CONFIG.USE_CACHE, '--use-cache'); // bool, default=True
    addFlag(CONFIG.FORCE_RERUN, '--force-rerun'); // bool, default=False
    addFlag(CONFIG.SKIP_TESTS, '--smart-skip-tests'); // bool, default=False
    addFlagAlways(CONFIG.LLM_CLIENT, '--llm'); // string, default=None --> uses GPT-4o mini by default
    addFlag(CONFIG.MIG_ROUNDS, '--rounds'); // list[str], default=None

    return commandParts.join(' ');
}
