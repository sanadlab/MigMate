import * as vscode from 'vscode';

class ContextService {
    private _context: vscode.ExtensionContext | undefined;

    public initialize(context: vscode.ExtensionContext) {
        this._context = context;
    }

    public get context(): vscode.ExtensionContext {
        if (!this._context) {
            throw new Error("ContextService not initialized");
        }
        return this._context;
    }

    public get secrets(): vscode.SecretStorage {
        return this.context.secrets;
    }
}

export const contextService = new ContextService();
