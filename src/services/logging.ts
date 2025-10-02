import * as vscode from 'vscode';



class LoggingService {
    private channel: vscode.OutputChannel;

    constructor() {
        this.channel = vscode.window.createOutputChannel('LibMig');
    }

    public info(message: string): void {
        this.channel.appendLine(`[INFO] ${new Date().toLocaleTimeString()}: ${message}`);
    }

    public warn(message: string): void {
        this.channel.appendLine(`[WARN] ${new Date().toLocaleTimeString()}: ${message}`);
    }

    public error(message: string, error?: Error): void {
        this.channel.appendLine(`[ERROR] ${new Date().toLocaleTimeString()}: ${message}`);
        if (error?.stack) {
            this.channel.appendLine(error.stack);
        }
    }

    public append(text: string): void { // for raw text
        this.channel.append(text);
    }

    public show(): void {
        this.channel.show(true);
    }

    public dispose(): void {
        this.channel.dispose();
    }
}

export const logger = new LoggingService();
