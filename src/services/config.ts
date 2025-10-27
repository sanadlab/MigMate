import * as vscode from 'vscode';
import { telemetryService } from './telemetry';



class ConfigService {
    private config: vscode.WorkspaceConfiguration;

    constructor() {
        this.config = vscode.workspace.getConfiguration('migmate');
    }

    public initialize(context: vscode.ExtensionContext) {
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('migmate')) {
                console.log("Update MigMate configuration");
			    telemetryService.sendTelemetryEvent('configChanged'); // check this
                this.config = vscode.workspace.getConfiguration('migmate');
            }
        }));
    }

    public get<T>(key: string, defaultValue: T): T;
    public get<T>(key: string): T | undefined;
    public get<T>(key: string, defaultValue?: T): T | undefined {
        if (defaultValue !== undefined) {
            return this.config.get<T>(key, defaultValue);
        }
        return this.config.get<T>(key);
    }

    public inspect<T>(key: string) {
        return this.config.inspect<T>(key);
    }
}

export const configService = new ConfigService();
