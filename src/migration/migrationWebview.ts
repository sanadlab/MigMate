import * as vscode from 'vscode';
import * as path from 'path';
import { MigrationChange, DiffHunk, migrationState } from './migrationState';
import { logger } from '../services/logging';
import { DiffUtils } from './diffUtils';

export class MigrationWebview {
    private panel: vscode.WebviewPanel | undefined;

    public async showPreview(changes: MigrationChange[], srcLib: string, tgtLib: string): Promise<void> {
        // // Create Webview panel if it doesn't exist or reuse existing
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

        // // Handle messages from Webview
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

                    case 'jumpToFile':
                        const uri = vscode.Uri.file(message.filePath);
                        const document = await vscode.workspace.openTextDocument(uri);
                        await vscode.window.showTextDocument(document);
                        break;

                    case 'viewDiff':
                        const originalUri = vscode.Uri.file(message.filePath);
                        const change = migrationState.getChange(originalUri);
                        if (change) {
                            const updatedUri = vscode.Uri.parse(`libmig-preview:${originalUri.fsPath}`);
                            const title = `${path.basename(originalUri.fsPath)} (Original ↔ Migrated)`;  // check this
                            await vscode.commands.executeCommand('vscode.diff', originalUri, updatedUri, title);
                        }
                        break;

                    case 'applyFileChanges':
                        await this.applyFileChanges(message.filePath);
                        break;

                    case 'applySingleChange':
                        await this.applySingleChange(
                            message.filePath,
                            message.hunkId
                        );
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
                if (!change) {continue;}

                const doc = await vscode.workspace.openTextDocument(uri);
                const eol = DiffUtils.getDocumentEOL(doc);
                const selectedHunkIds = new Set(file.selectedHunks);
                const processedHunkIds = new Set<number>();

                // // Sort hunks by line number to process them from top to bottom
                const hunks = [...change.hunks].sort((a, b) => a.originalStartLine - b.originalStartLine);

                for (const hunk of hunks) {
                    if (!selectedHunkIds.has(hunk.id) || processedHunkIds.has(hunk.id)) {continue;}

                    const pairedHunk = DiffUtils.findPairedHunk(hunk, hunks);
                    // // Replacement case
                    if (pairedHunk) {
                        if (selectedHunkIds.has(pairedHunk.id)) {
                            const removalHunk = hunk.type === 'removed' ? hunk : pairedHunk;
                            const additionHunk = hunk.type === 'added' ? hunk : pairedHunk;
                            const range = new vscode.Range(
                                new vscode.Position(removalHunk.originalStartLine, 0),
                                new vscode.Position(removalHunk.originalStartLine + removalHunk.lines.length, 0)
                            );
                            const newText = DiffUtils.getReplacementText(additionHunk, doc);
                            edit.replace(uri, range, newText);
                            processedHunkIds.add(hunk.id);
                            processedHunkIds.add(pairedHunk.id);
                        } else {
                            migrationState.handleSingleHunk(edit, uri, hunk, eol, false);
                            processedHunkIds.add(hunk.id);
                        }
                    }
                    // // Standalone add/delete
                    else {
                        migrationState.handleSingleHunk(edit, uri, hunk, eol, false);
                        processedHunkIds.add(hunk.id);
                    }
                }
            }

            // // Apply the edits
            const success = await vscode.workspace.applyEdit(edit);
            if (success) {
                // Save all modified documents
                const docsToSave = new Set<string>();
                for (const file of selectedFiles) {
                    docsToSave.add(file.path);
                }
                for (const docPath of docsToSave) {
                    const uri = vscode.Uri.file(docPath);
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await doc.save();
                }
                vscode.window.showInformationMessage('Migration changes applied successfully');
            } else {
                vscode.window.showWarningMessage('Could not apply Webview changes');
            }

        } catch (error) {
            logger.error(`Error applying selected changes: ${error}`);
            vscode.window.showErrorMessage('Failed to apply migration changes');
        }
    }

    private async applyFileChanges(filePath: string): Promise<void> {
        const uri = vscode.Uri.file(filePath);
        const change = migrationState.getChange(uri);
        if (!change) {
            logger.warn(`Could not find Webview change for file: ${filePath}`);
            return;
        }
        const selectedFile = {
            path: filePath,
            selectedHunks: change.hunks.map(h => h.id)
        };
        await this.applySelectedChanges([selectedFile]);
    }

    private async applySingleChange(filePath: string, hunkId: number): Promise<void> {
        try {
            const uri = vscode.Uri.file(filePath);
            const change = migrationState.getChange(uri);
            if (!change) {
                logger.warn(`Could not find Webview change for hunk ${hunkId} in file: ${filePath}`);
                return;
            }
            const hunkToApply = change.hunks.find(h => h.id === hunkId);
            if (!hunkToApply) {
                logger.warn(`Could not find Webview hunk ${hunkId} in file: ${filePath}`);
                return;
            }

            const doc = await vscode.workspace.openTextDocument(uri);
            const eol = doc.eol === vscode.EndOfLine.LF ? '\n' : '\r\n';
            const pairedHunk = DiffUtils.findPairedHunk(hunkToApply, change.hunks);
            const edit = DiffUtils.createHunkEdit(hunkToApply, uri, eol, pairedHunk, false);

            // // Apply the edit
            const success = await vscode.workspace.applyEdit(edit);
            if (success) {
                // // Save the document
                await doc.save();
                logger.info(`Applied hunk ${hunkToApply.id} at line ${hunkToApply.originalStartLine + 1} in ${path.basename(filePath)}`);
            } else {
                logger.error(`Failed to apply hunk ${hunkToApply.id} at line ${hunkToApply.originalStartLine + 1} in ${path.basename(filePath)}`);
                vscode.window.showErrorMessage("Failed to apply change");
            }
        } catch (error) {
            logger.error(`Error applying single change: ${error}`);
            vscode.window.showErrorMessage('Failed to apply change');
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
                padding: 15px;
                margin-bottom: 20px;
                border-radius: 3px;
                display: flex;
                justify-content: space-around;
                align-items: center;
            }
            .info-item {
                display: flex;
                flex-direction: column;
                align-items: center;
            }
            .info-label {
                font-size: 0.9em;
                color: var(--vscode-descriptionForeground);
            }
            .info-value {
                font-size: 1.1em;
                font-weight: bold;
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
                cursor: pointer;
            }
            .file-path {
                margin-left: 8px;
                font-weight: bold;
            }
            .file-summary {
                margin-left: 10px;
                font-style: italic;
                color: var(--vscode-descriptionForeground);
                display: none;
            }
            .dropdown-arrow {
                margin-left: 10px;
                width: 0;
                height: 0;
                border-top: 5px solid transparent;
                border-bottom: 5px solid transparent;
                border-left: 5px solid currentColor;
                transition: transform 0.2s ease-in-out;
            }
            details[open] > summary .dropdown-arrow {
                transform: rotate(90deg);
            }
            details:not([open]) > summary .file-summary {
                display: inline;
            }
            .file-header-buttons {
                margin-left: auto;
                display: flex;
                gap: 5px;
            }
            .apply-file-button {
                margin-left: 10px;
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 4px 8px;
                border-radius: 3px;
                cursor: pointer;
            }
            .jump-to-file-button, .view-diff-button {
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
                color: var(--vscode-editor-foreground);
            }
            .hunk-type-removed {
                background: var(--vscode-diffEditor-removedTextBackground);
                color: var(--vscode-editor-foreground);
            }
            .hunk-type-replaced {
                background: var(--vscode-badge-background);
                color: var(--vscode-editor-foreground);
            }
            .hunk-content {
                font-family: var(--vscode-editor-font-family);
                padding: 8px;
                white-space: pre-wrap;
                overflow-x: auto;
                font-size: var(--vscode-editor-font-size);
            }
            .hunk-content-removed {
                background: var(--vscode-diffEditor-removedTextBackground);
                border-radius: 3px;
            }
            .hunk-content-added {
                background: var(--vscode-diffEditor-insertedTextBackground);
                border-radius: 3px;
            }
            .buttons {
                display: flex;
                justify-content: flex-end;
                margin-top: 20px;
                gap: 10px;
            }
            .apply-single-button {
                margin-left: auto;
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 4px 8px;
                border-radius: 3px;
                cursor: pointer;
                font-size: 0.8em;
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
                <div class="info-item">
                    <span class="info-label">Source Library</span>
                    <span class="info-value">${srcLib}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Target Library</span>
                    <span class="info-value">${tgtLib}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Files to Update</span>
                    <span class="info-value">${filesCount}</span>
                </div>
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
        const hunks = change.hunks;
        const processedHunkIds = new Set<number>();
        let hunksHtml = '';
        const totalChanges = change.hunks.filter(h => h.type === 'removed').length + change.hunks.filter(h => h.type === 'added' && !h.pairedHunkId).length;

        // Pre-process hunks to group pairs into replacements
        for (const hunk of hunks) {
            if (processedHunkIds.has(hunk.id)) {
                continue;
            }
            const pairedHunk = DiffUtils.findPairedHunk(hunk, hunks);
            if (pairedHunk) {
                // Replacement --> render a single block for the pair
                const removalHunk = hunk.type === 'removed' ? hunk : pairedHunk;
                const additionHunk = hunk.type === 'added' ? hunk : pairedHunk;
                hunksHtml += this.generateReplacementHunkItem(removalHunk, additionHunk, fileIndex);
                processedHunkIds.add(removalHunk.id);
                processedHunkIds.add(additionHunk.id);
            } else {
                // Standlone add/remove
                hunksHtml += this.generateSingleHunkItem(hunk, fileIndex);
                processedHunkIds.add(hunk.id);
            }
        }
        return `<details class="file-item" data-file-path="${change.uri.fsPath}" data-file-index="${fileIndex}" open>
            <summary class="file-header">
                <input type="checkbox" class="file-checkbox" data-file-index="${fileIndex}" checked>
                <span class="file-path">${path.basename(change.uri.fsPath)}</span>
                <span class="dropdown-arrow"></span>
                <span class="file-summary" data-file-index="${fileIndex}">${totalChanges} changes</span>
                <div class="file-header-buttons">
                    <button class="jump-to-file-button" data-file-path="${change.uri.fsPath}">View File</button>
                    <button class="view-diff-button" data-file-path="${change.uri.fsPath}">View Diff</button>
                </div>
                <button class="apply-file-button" data-file-path="${change.uri.fsPath}">Apply File Changes</button>
            </summary>
            <div class="hunks">
                ${hunksHtml}
            </div>
        </details>`;
    }

    private generateSingleHunkItem(hunk: DiffHunk, fileIndex: number): string {
        return `<div class="hunk-container" data-hunk-id="${hunk.id}" data-file-index="${fileIndex}">
            <div class="hunk-header">
                <input type="checkbox" class="hunk-checkbox"
                    data-hunk-id="${hunk.id}"
                    data-file-index="${fileIndex}" checked>
                <span class="hunk-type ${hunk.type === 'added' ? 'hunk-type-added' : 'hunk-type-removed'}">
                    ${hunk.type === 'added' ? 'Added' : 'Removed'} at line ${hunk.originalStartLine + 1}
                </span>
                <button class="apply-single-button" data-hunk-id="${hunk.id}" data-file-index="${fileIndex}">
                    Apply
                </button>
            </div>
            <div class="hunk-content ${hunk.type === 'added' ? 'hunk-content-added' : 'hunk-content-removed'}">${this.escapeHtml(hunk.lines.join('\n'))}</div>
        </div>`;
    }

    private generateReplacementHunkItem(removalHunk: DiffHunk, additionHunk: DiffHunk, fileIndex: number): string {
        const hunkIds = `${removalHunk.id},${additionHunk.id}`;
        return `<div class="hunk-container" data-hunk-id="${hunkIds}" data-file-index="${fileIndex}">
            <div class="hunk-header">
                <input type="checkbox" class="hunk-checkbox"
                    data-hunk-id="${hunkIds}"
                    data-file-index="${fileIndex}" checked>
                <span class="hunk-type hunk-type-replaced">
                    Replaced at line ${removalHunk.originalStartLine + 1}
                </span>
                <button class="apply-single-button" data-hunk-id="${hunkIds}" data-file-index="${fileIndex}">
                    Apply
                </button>
            </div>
            <div class="hunk-content hunk-content-removed">${this.escapeHtml(removalHunk.lines.join('\n'))}</div>
            <div class="hunk-content hunk-content-added">${this.escapeHtml(additionHunk.lines.join('\n'))}</div>
        </div>`;
    }

    private generateButtons(): string {
        return `<div class="buttons">
            <button class="cancel-button">Close Preview</button>
            <button class="apply-button">Apply Selected Changes</button>
        </div>`;
    }

    private generateScript(filesJson: string): string {
        return `<script>
            // // Log the state of the Webview
            function debugState() {
                console.log('Total file items:', document.querySelectorAll('.file-item').length);
                console.log('Total file checkboxes:', document.querySelectorAll('.file-checkbox').length);
                console.log('Checked file checkboxes:', document.querySelectorAll('.file-checkbox:checked').length);
                console.log('Total hunk checkboxes:', document.querySelectorAll('.hunk-checkbox').length);
                console.log('Checked hunk checkboxes:', document.querySelectorAll('.hunk-checkbox:checked').length);
                console.log('Select all checked:', document.getElementById('select-all').checked);
            }

            // // Get VS Code API
            const vscode = acquireVsCodeApi();

            // // Track all selected hunks
            const files = ${filesJson};

            // // Function to update the "select all" checkbox state based on all other checkboxes
            function updateSelectAllState() {
                const allCheckboxes = document.querySelectorAll('.hunk-checkbox, .file-checkbox');
                const allChecked = Array.from(allCheckboxes).every(cb => cb.checked);
                document.getElementById('select-all').checked = allChecked;
            }

            // // Listen for checkbox changes
            document.addEventListener('DOMContentLoaded', () => {
                // // Handle select all checkbox
                const selectAllCheckbox = document.getElementById('select-all');
                selectAllCheckbox.addEventListener('change', () => {
                    const isChecked = selectAllCheckbox.checked;
                    document.querySelectorAll('.file-checkbox, .hunk-checkbox').forEach(checkbox => {
                        checkbox.checked = isChecked;
                    });
                });

                // // Handle file checkboxes
                document.querySelectorAll('.file-checkbox').forEach(checkbox => {
                    checkbox.addEventListener('change', () => {
                        const fileIndex = parseInt(checkbox.getAttribute('data-file-index'));
                        const isChecked = checkbox.checked;

                        // // Update all hunks in this file
                        document.querySelectorAll('.hunk-checkbox[data-file-index="' + fileIndex + '"]').forEach(hunkCheckbox => {
                            hunkCheckbox.checked = isChecked;
                        });

                        // // Update the "select all" checkbox state
                        updateSelectAllState();
                    });
                });

                // // Handle hunk checkboxes
                document.querySelectorAll('.hunk-checkbox').forEach(checkbox => {
                    checkbox.addEventListener('change', () => {
                        // // Check if all hunks in file are selected/deselected
                        const fileIndex = parseInt(checkbox.getAttribute('data-file-index'));
                        const fileCheckbox = document.querySelector('.file-checkbox[data-file-index="' + fileIndex + '"]');
                        const allHunkCheckboxes = document.querySelectorAll('.hunk-checkbox[data-file-index="' + fileIndex + '"]');
                        const allChecked = Array.from(allHunkCheckboxes).every(cb => cb.checked);

                        fileCheckbox.checked = allChecked;

                        // // Update the global select-all checkbox
                        updateSelectAllState();
                    });
                });

                // // Handle jump to file buttons
                document.querySelectorAll('.jump-to-file-button').forEach(button => {
                    button.addEventListener('click', () => {
                        const filePath = button.getAttribute('data-file-path');
                        vscode.postMessage({
                            command: 'jumpToFile',
                            filePath
                        });
                    });
                });

                // // Handle view diff buttons
                document.querySelectorAll('.view-diff-button').forEach(button => {
                    button.addEventListener('click', () => {
                        const filePath = button.getAttribute('data-file-path');
                        vscode.postMessage({
                            command: 'viewDiff',
                            filePath
                        });
                    });
                });

                // // Handle apply file changes buttons
                document.querySelectorAll('.apply-file-button').forEach(button => {
                    button.addEventListener('click', () => {
                        const filePath = button.getAttribute('data-file-path');
                        vscode.postMessage({
                            command: 'applyFileChanges',
                            filePath
                        });
                    });
                });

                // // Handle apply button
                document.querySelector('.apply-button').addEventListener('click', () => {
                    console.log('Apply button clicked');
                    debugState();
                    const selectedFiles = files.map((file, index) => {
                        // // Find the parent file container
                        const fileContainer = document.querySelector('.file-item[data-file-index="' + index + '"]');
                        if (!fileContainer) return null;

                        const selectedHunks = file.hunks.filter(hunkId => {
                            // // Find the checkbox within the specific file container
                            const checkbox = fileContainer.querySelector('.hunk-checkbox[data-hunk-id="' + hunkId + '"]');
                            return checkbox && checkbox.checked;
                        });

                        return {
                            path: file.path,
                            selectedHunks
                        };
                    }).filter(file => file && file.selectedHunks.length > 0);

                    vscode.postMessage({
                        command: 'applyChanges',
                        files: selectedFiles
                    });
                });

                // // Handle cancel button
                document.querySelector('.cancel-button').addEventListener('click', () => {
                    vscode.postMessage({
                        command: 'cancel'
                    });
                });

                // // Handle individual apply buttons
                document.querySelectorAll('.apply-single-button').forEach(button => {
                    button.addEventListener('click', () => {
                        // The hunkId can now be a single ID or a comma-separated pair
                        const hunkIdString = button.getAttribute('data-hunk-id');
                        const fileIndex = parseInt(button.getAttribute('data-file-index'));
                        const fileInfo = files[fileIndex];
                        const filePath = fileInfo.path;

                        // We only need to send the first ID of a pair to the backend.
                        // The backend logic will find the partner automatically.
                        const primaryHunkId = parseInt(hunkIdString.split(',')[0]);

                        // Send message to apply the change
                        vscode.postMessage({
                            command: 'applySingleChange',
                            filePath: filePath,
                            hunkId: primaryHunkId,
                        });

                        // Disable this button and update UI to show change was applied
                        button.disabled = true;
                        button.textContent = 'Applied';
                        const checkbox = document.querySelector(
                            \`.hunk-checkbox[data-hunk-id="\${hunkIdString}"]\`
                        );
                        if (checkbox) {
                            checkbox.disabled = true;
                        }
                    });
                });
            });
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
