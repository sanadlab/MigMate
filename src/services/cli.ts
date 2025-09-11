import * as vscode from 'vscode';
import { spawn } from 'child_process';



let libmigChannel: vscode.OutputChannel;

function getOutputChannel(): vscode.OutputChannel {
    if (!libmigChannel) {
        libmigChannel = vscode.window.createOutputChannel('LibMig');
    }
    return libmigChannel;
}


// // Run target command in CLI
export function runCliTool(command: string, cwd: string) {
    const channel = getOutputChannel();
    channel.show(true);
    channel.appendLine(`Running command: ${command}\n`);

    // add timeout?
    const startTime = Date.now();

    // check this
    return new Promise<void>((resolve, reject) => {
        const [cmd, ...args] = command.split(' ');
        const child = spawn(cmd, args, { cwd, shell: true });

        child.stdout.on('data', (data: Buffer) => {
            channel.append(data.toString());
        });
        child.stderr.on('data', (data: Buffer) => {
            channel.append(data.toString());
        });
        child.on('close', (code) => {
            channel.appendLine(`\nCommand finished with exit code: ${code}`);
            if (code === 0) {
                vscode.window.showInformationMessage('LibMig process completed successfully');
                resolve();
            } else {
                vscode.window.showErrorMessage(`LibMig process failed with exit code ${code}`);
                reject(new Error(`Process failed with exit code ${code}`));
            }
        });
        child.on('error', (err) => {
            vscode.window.showErrorMessage(`Failed with error: ${err.message}`);
            channel.appendLine(`\nError: ${err.message}`);
            reject(err);
        });
    });
}
