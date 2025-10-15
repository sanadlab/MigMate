import * as vscode from 'vscode';
import * as path from 'path';
import { MigrationChange, DiffHunk, migrationState } from '../services/migrationState';
import { logger } from '../services/logging';

export class MigrationWebview {
    private panel: vscode.WebviewPanel | undefined;

    public async showPreview(changes: MigrationChange[], srcLib: string, tgtLib: string): Promise<void> {
        // // Create webview panel if it doesn't exist or reuse existing
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                'migrationPreview',
                `Migration Preview: ${srcLib} → ${tgtLib}`,
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: false
                }
            );

            // // Reset the panel reference when closed
            this.panel.onDidDispose(() => {
                this.panel = undefined;
            });
        } else {
            this.panel.title = `Migration Preview: ${srcLib} → ${tgtLib}`;
            this.panel.reveal(vscode.ViewColumn.One);
        }

        // // Generate HTML
        this.panel.webview.html = this.generatePreviewHtml(changes, srcLib, tgtLib);

        // // Handle messages from webview
        this.panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'applyChanges':
                        await this.applySelectedChanges(message.files);
                        this.panel?.dispose();
                        break;

                    case 'cancel':
                        this.panel?.dispose();
                        break;

                    case 'viewDiff':
                        const uri = vscode.Uri.file(message.filePath);
                        const document = await vscode.workspace.openTextDocument(uri);
                        await vscode.window.showTextDocument(document);
                        break;
                }
            }
        );
    }

    // // Apply only selected changes to the workspace
    private async applySelectedChanges(selectedFiles: Array<{ path: string, selectedHunks: number[] }>): Promise<void> {
        try {
            const edit = new vscode.WorkspaceEdit();

            for (const file of selectedFiles) {
                const uri = vscode.Uri.file(file.path);
                const change = migrationState.getChange(uri);
                if (!change) { continue; }

                const doc = await vscode.workspace.openTextDocument(uri);
                const eol = doc.eol === vscode.EndOfLine.LF ? '\n' : '\r\n';
                const selectedHunkIds = new Set(file.selectedHunks);
                const processedHunkIds = new Set<number>();

                // // Sort hunks by line number to process them from top to bottom
                const hunks = [...change.hunks].sort((a, b) => a.originalStartLine - b.originalStartLine);

                for (let i = 0; i < hunks.length; i++) {
                    const currentHunk = hunks[i];
                    if (!selectedHunkIds.has(currentHunk.id) || processedHunkIds.has(currentHunk.id)) {
                        continue;
                    }

                    // // Attempt to find a paired hunk for replacement
                    if (currentHunk.type === 'removed' && i + 1 < hunks.length) {
                        const nextHunk = hunks[i + 1];
                        // // Check if the next hunk is an 'added' hunk at the same line and is also selected
                        if (nextHunk.type === 'added' &&
                            nextHunk.originalStartLine === currentHunk.originalStartLine &&
                            selectedHunkIds.has(nextHunk.id))
                        {
                            // // Handle replacement operation
                            const range = new vscode.Range(
                                new vscode.Position(currentHunk.originalStartLine, 0),
                                new vscode.Position(currentHunk.originalStartLine + currentHunk.lines.length, 0)
                            );
                            const newText = nextHunk.lines.join(eol) + (nextHunk.lines.length > 0 ? eol : '');

                            edit.replace(uri, range, newText);

                            // // Mark both hunks as processed
                            processedHunkIds.add(currentHunk.id);
                            processedHunkIds.add(nextHunk.id);
                            continue; // Move to the next hunk
                        }
                    }

                    // // If it's not a replacement, handle it as a standalone hunk
                    await migrationState.handleSingleHunk(edit, uri, currentHunk, eol, false);
                    processedHunkIds.add(currentHunk.id);
                }
            }

            // // Apply the edits
            const success = await vscode.workspace.applyEdit(edit);
            if (success) {
                vscode.window.showInformationMessage('Migration changes applied successfully');
            } else {
                vscode.window.showWarningMessage('Could not apply webview changes');
            }

        } catch (error) {
            logger.error(`Error applying selected changes: ${error}`);
            vscode.window.showErrorMessage('Failed to apply migration changes');
        }
    }

    // // HTML Generation Methods
    private generatePreviewHtml(changes: MigrationChange[], srcLib: string, tgtLib: string): string {
        // // Create the files data structure and stringify it safely
        const filesData = JSON.stringify(changes.map(change => ({
            path: change.uri.fsPath,
            hunks: change.hunks.map(hunk => hunk.id)
        }))).replace(/`/g, '\\`');

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Migration Preview</title>
            ${this.generateStyles()}
        </head>
        <body>
            ${this.generateHeader(srcLib, tgtLib, changes.length)}
            ${this.generateFilesList(changes)}
            ${this.generateButtons()}
            ${this.generateScript(filesData)}
        </body>
        </html>`;
    }

    private generateStyles(): string {
        return `<style>
            body {
                font-family: var(--vscode-font-family);
                color: var(--vscode-editor-foreground);
                background-color: var(--vscode-editor-background);
                padding: 20px;
            }
            .header {
                margin-bottom: 20px;
            }
            .migration-info {
                background: var(--vscode-editorWidget-background);
                border-left: 3px solid var(--vscode-activityBar-activeBorder);
                padding: 10px;
                margin-bottom: 20px;
                border-radius: 3px;
            }
            .file-item {
                margin-bottom: 15px;
                background: var(--vscode-editorWidget-background);
                border: 1px solid var(--vscode-panel-border);
                border-radius: 5px;
            }
            .file-header {
                padding: 8px;
                background: var(--vscode-sideBarSectionHeader-background);
                border-bottom: 1px solid var(--vscode-panel-border);
                display: flex;
                align-items: center;
            }
            .file-path {
                margin-left: 8px;
                flex-grow: 1;
                font-weight: bold;
            }
            .view-diff-button {
                background: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
                border: none;
                padding: 4px 8px;
                border-radius: 3px;
                cursor: pointer;
            }
            .hunk-container {
                padding: 8px;
                border-bottom: 1px solid var(--vscode-panel-border);
            }
            .hunk-container:last-child {
                border-bottom: none;
            }
            .hunk-header {
                display: flex;
                align-items: center;
                margin-bottom: 8px;
            }
            .hunk-type {
                font-size: 0.9em;
                padding: 2px 6px;
                border-radius: 3px;
                margin-left: 10px;
            }
            .hunk-type-added {
                background: var(--vscode-diffEditor-insertedTextBackground);
                color: var(--vscode-gitDecoration-addedResourceForeground);
            }
            .hunk-type-removed {
                background: var(--vscode-diffEditor-removedTextBackground);
                color: var(--vscode-gitDecoration-deletedResourceForeground);
            }
            .hunk-content {
                background: var(--vscode-editor-background);
                font-family: var(--vscode-editor-font-family);
                padding: 8px;
                border-radius: 3px;
                white-space: pre;
                overflow-x: auto;
                font-size: var(--vscode-editor-font-size);
            }
            .buttons {
                display: flex;
                justify-content: flex-end;
                margin-top: 20px;
                gap: 10px;
            }
            .apply-button {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 8px 16px;
                border-radius: 3px;
                cursor: pointer;
            }
            .cancel-button {
                background: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
                border: none;
                padding: 8px 16px;
                border-radius: 3px;
                cursor: pointer;
            }
            .select-all-checkbox {
                margin-bottom: 10px;
            }
        </style>`;
    }

    private generateHeader(srcLib: string, tgtLib: string, filesCount: number): string {
        return `<div class="header">
            <h2>Migration Preview</h2>
            <div class="migration-info">
                <div><strong>Source Library:</strong> ${srcLib}</div>
                <div><strong>Target Library:</strong> ${tgtLib}</div>
                <div><strong>Files to Update:</strong> ${filesCount}</div>
            </div>
            <div class="select-all-checkbox">
                <input type="checkbox" id="select-all" checked>
                <label for="select-all">Select All Changes</label>
            </div>
        </div>`;
    }

    private generateFilesList(changes: MigrationChange[]): string {
        const fileItems = changes.map((change, fileIndex) =>
            this.generateFileItem(change, fileIndex)
        ).join('');

        return `<div class="files-list">${fileItems}</div>`;
    }

    private generateFileItem(change: MigrationChange, fileIndex: number): string {
        const hunksHtml = change.hunks.map(hunk =>
            this.generateHunkItem(hunk, fileIndex)
        ).join('');

        return `<div class="file-item" data-file-path="${change.uri.fsPath}">
            <div class="file-header">
                <input type="checkbox" class="file-checkbox" data-file-index="${fileIndex}" checked>
                <span class="file-path">${path.basename(change.uri.fsPath)}</span>
                <button class="view-diff-button" data-file-path="${change.uri.fsPath}">View File</button>
            </div>
            <div class="hunks">
                ${hunksHtml}
            </div>
        </div>`;
    }

    private generateHunkItem(hunk: DiffHunk, fileIndex: number): string {
        return `<div class="hunk-container" data-hunk-id="${hunk.id}" data-file-index="${fileIndex}">
            <div class="hunk-header">
                <input type="checkbox" class="hunk-checkbox"
                    data-hunk-id="${hunk.id}"
                    data-file-index="${fileIndex}" checked>
                <span class="hunk-type ${hunk.type === 'added' ? 'hunk-type-added' : 'hunk-type-removed'}">
                    ${hunk.type === 'added' ? 'Added' : 'Removed'} at line ${hunk.originalStartLine + 1}
                </span>
            </div>
            <div class="hunk-content">
                ${this.escapeHtml(hunk.lines.join('\n'))}
            </div>
        </div>`;
    }

    private generateButtons(): string {
        return `<div class="buttons">
            <button class="cancel-button">Cancel</button>
            <button class="apply-button">Apply Selected Changes</button>
        </div>`;
    }

    private generateScript(filesJson: string): string {
        return `<script>
            // Get VS Code API
            const vscode = acquireVsCodeApi();

            // Track all selected hunks
            const files = ${filesJson};

            // Listen for checkbox changes
            document.addEventListener('DOMContentLoaded', () => {
                // Handle select all checkbox
                const selectAllCheckbox = document.getElementById('select-all');
                selectAllCheckbox.addEventListener('change', () => {
                    const isChecked = selectAllCheckbox.checked;
                    document.querySelectorAll('.file-checkbox, .hunk-checkbox').forEach(checkbox => {
                        checkbox.checked = isChecked;
                        updateSelection(checkbox);
                    });
                });

                // Handle file checkboxes
                document.querySelectorAll('.file-checkbox').forEach(checkbox => {
                    checkbox.addEventListener('change', () => {
                        const fileIndex = parseInt(checkbox.getAttribute('data-file-index'));
                        const isChecked = checkbox.checked;

                        // Update all hunks in this file
                        document.querySelectorAll('.hunk-checkbox[data-file-index="' + fileIndex + '"]').forEach(hunkCheckbox => {
                            hunkCheckbox.checked = isChecked;
                            updateSelection(hunkCheckbox);
                        });
                    });
                });

                // Handle hunk checkboxes
                document.querySelectorAll('.hunk-checkbox').forEach(checkbox => {
                    checkbox.addEventListener('change', () => {
                        updateSelection(checkbox);

                        // Check if all hunks in file are selected/deselected
                        const fileIndex = parseInt(checkbox.getAttribute('data-file-index'));
                        const fileCheckbox = document.querySelector('.file-checkbox[data-file-index="' + fileIndex + '"]');
                        const allHunkCheckboxes = document.querySelectorAll('.hunk-checkbox[data-file-index="' + fileIndex + '"]');
                        const allChecked = Array.from(allHunkCheckboxes).every(cb => cb.checked);

                        fileCheckbox.checked = allChecked;
                    });
                });

                // Handle view diff buttons
                document.querySelectorAll('.view-diff-button').forEach(button => {
                    button.addEventListener('click', () => {
                        const filePath = button.getAttribute('data-file-path');
                        vscode.postMessage({
                            command: 'viewDiff',
                            filePath
                        });
                    });
                });

                // Handle apply button
                document.querySelector('.apply-button').addEventListener('click', () => {
                    const selectedFiles = files.map(file => {
                        const selectedHunks = file.hunks.filter(hunkId => {
                            // Use string concatenation instead of template literals
                            const checkbox = document.querySelector('.hunk-checkbox[data-hunk-id="' + hunkId + '"]');
                            return checkbox && checkbox.checked;
                        });
                        return {
                            path: file.path,
                            selectedHunks
                        };
                    }).filter(file => file.selectedHunks.length > 0);

                    vscode.postMessage({
                        command: 'applyChanges',
                        files: selectedFiles
                    });
                });

                // Handle cancel button
                document.querySelector('.cancel-button').addEventListener('click', () => {
                    vscode.postMessage({
                        command: 'cancel'
                    });
                });
            });

            function updateSelection(checkbox) {
                const hunkId = parseInt(checkbox.getAttribute('data-hunk-id'));
                const fileIndex = parseInt(checkbox.getAttribute('data-file-index'));

                if (isNaN(hunkId) || isNaN(fileIndex)) return;

                // Update the tracking object
                const isChecked = checkbox.checked;
                if (!isChecked) {
                    // Update the select all checkbox
                    document.getElementById('select-all').checked = false;
                }
            }
        </script>`;
    }

    private escapeHtml(unsafe: string): string {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;")
            .replace(/`/g, "&#96;");
    }
}
