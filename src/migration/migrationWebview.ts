import * as vscode from 'vscode';
import * as path from 'path';
import { MigrationChange, DiffHunk, migrationState } from './migrationState';
import { logger } from '../services/logging';
import { DiffUtils } from './diffUtils';
import { escapeHtml } from '../webviewUtils';

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
        this.panel.webview.html = await this.generatePreviewHtml(changes, srcLib, tgtLib);

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
                // // Save all modified documents
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
    private async generatePreviewHtml(changes: MigrationChange[], srcLib: string, tgtLib: string): Promise<string> {
        // // Create the files data structure and stringify it safely
        const filesData = JSON.stringify(changes.map(change => ({
            path: change.uri.fsPath,
            hunks: change.hunks.map(hunk => hunk.id)
        }))).replace(/`/g, '\\`');

        const fileItemsHtml = (await Promise.all(changes.map((change, fileIndex) => this.generateFileItem(change, fileIndex)))).join('');

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
            <div class="files-list">${fileItemsHtml}</div>
            <div class="buttons">
                <button class="cancel-button">Close Preview</button>
                <button class="apply-all-button">Apply All Changes</button>
            </div>
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
                overflow: hidden;
            }
            .file-header {
                padding: 8px;
                background: var(--vscode-sideBarSectionHeader-background);
                border-bottom: 1px solid var(--vscode-panel-border);
                display: flex;
                align-items: center;
                cursor: pointer;
                gap: 10px;
            }
            .file-path {
                margin-left: 8px;
                font-weight: bold;
                flex-shrink: 0;
            }
            .file-summary {
                margin-left: 0;
                font-style: italic;
                color: var(--vscode-descriptionForeground);
                display: none;
                white-space: nowrap;
            }
            .dropdown-arrow {
                margin-left: 0;
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
                flex-shrink: 0;
            }
            .apply-file-button, .apply-all-button {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 8px 16px;
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
            .file-content {
                font-family: var(--vscode-editor-font-family);
                font-size: var(--vscode-editor-font-size);
                padding: 10px;
                background-color: var(--vscode-editor-background);
                border-radius: 4px;
                margin: 8px;
                border: 1px solid var(--vscode-panel-border);
            }
            .line-container {
                display: flex;
                min-height: 1.2em;
                white-space: pre;
            }
            .line-numbers-gutter {
                flex: 0 0 55px;
                user-select: none;
                color: var(--vscode-editorLineNumber-foreground);
                text-align: right;
                padding-right: 10px;
            }
            .line-num-old, .line-num-new {
                display: inline-block;
                width: 30px;
                opacity: 0.7;
            }
            .line-content-main {
                flex-grow: 1;
                padding-left: 10px;
                position: relative;
                overflow-x: auto;
            }
            .line-action-gutter {
                flex: 0 0 90px;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .line-removed {
                background-color: var(--vscode-diffEditor-removedTextBackground);
            }
            .line-added {
                background-color: var(--vscode-diffEditor-insertedTextBackground);
            }
            .line-removed::before, .line-added::before {
                position: absolute;
                left: 0;
            }
            .line-removed::before {
                content: "-";
            }
            .line-added::before {
                content: "+";
            }
            .change-region {
                // margin: 8px 0;
                // border: 1px solid var(--vscode-panel-border);
                border-radius: 4px;
                display: flex;
            }
            .change-region-lines {
                flex-grow: 1;
                overflow: hidden;
            }
            .apply-change-button {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 2px 0;
                border-radius: 3px;
                cursor: pointer;
                font-size: 0.9em;
                width: 70px;
                min-width: 70px;
                text-align: center;
            }
            .buttons {
                display: flex;
                justify-content: flex-end;
                // margin-top: 20px;
                padding-top: 10px;
                // border-top: 1px solid var(--vscode-panel-border);
                gap: 10px;
            }
            .cancel-button {
                background: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
                border: none;
                padding: 8px 16px;
                border-radius: 3px;
                cursor: pointer;
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
        </div>`;
    }

    private async generateFileItem(change: MigrationChange, fileIndex: number): Promise<string> {
        try {
            const filePath = change.uri.fsPath;
            const doc = await vscode.workspace.openTextDocument(change.uri);
            const fileContent = doc.getText();
            const fileLines = fileContent.split(/\r?\n/);
            const lineDetails: { [key: number]: { type: string, hunkIds: number[], content?: string } } = {};
            const hunks = change.hunks;

            // // Handle removals first
            for (const hunk of hunks) {
                if (hunk.type === 'removed') {
                    for (let i = 0; i < hunk.lines.length; i++) {
                        const lineNum = hunk.originalStartLine + i;
                        lineDetails[lineNum] = { type: 'removed', hunkIds: [hunk.id] };
                    }
                }
            }

            // // Handle additions and check if part of a replacement
            for (const hunk of hunks) {
                if (hunk.type === 'added') {
                    const pairedHunk = DiffUtils.findPairedHunk(hunk, hunks);
                    if (pairedHunk) {
                        // // Replacement case
                        const targetLine = pairedHunk.originalStartLine;
                        if (lineDetails[targetLine]) {
                            lineDetails[targetLine].type = 'replaced';
                            lineDetails[targetLine].hunkIds.push(hunk.id);
                            lineDetails[targetLine].content = hunk.lines.join('\n');
                        }
                    } else {
                        // // Standalone addition
                        const targetLine = hunk.originalStartLine;
                        lineDetails[targetLine] = {
                            type: 'added',
                            hunkIds: [hunk.id],
                            content: hunk.lines.join('\n')
                        };
                    }
                }
            }

            let contentHtml = '<div class="file-content">';
            let oldLineNum = 1;
            let newLineNum = 1;

            while (oldLineNum <= fileLines.length) {
                const lineIndex = oldLineNum - 1;
                if (lineDetails[lineIndex]) {
                    const detail = lineDetails[lineIndex];
                    const hunkIds = detail.hunkIds.join(',');

                    let changeBlockHtml = '';

                    if (detail.type === 'removed' || detail.type === 'replaced') {
                        let endLine = lineIndex;
                        while(lineDetails[endLine + 1] && lineDetails[endLine + 1].type === 'removed') {
                            endLine++;
                        }
                        for (let j = lineIndex; j <= endLine; j++) {
                            changeBlockHtml += `<div class="line-container">
                                <div class="line-numbers-gutter"><span class="line-num-old">${oldLineNum + (j - lineIndex)}</span><span class="line-num-new"></span></div>
                                <div class="line-content-main line-removed">${escapeHtml(fileLines[j] || ' ')}</div>
                            </div>`;
                        }
                        oldLineNum += (endLine - lineIndex + 1);
                    }

                    if (detail.type === 'added' || detail.type === 'replaced') {
                        const lines = detail.content?.split('\n') || [];
                        for (const line of lines) {
                            changeBlockHtml += `<div class="line-container">
                                <div class="line-numbers-gutter"><span class="line-num-old"></span><span class="line-num-new">${newLineNum++}</span></div>
                                <div class="line-content-main line-added">${escapeHtml(line || ' ')}</div>
                            </div>`;
                        }
                    }

                    contentHtml += `<div class="change-region">
                        <div class="change-region-lines">${changeBlockHtml}</div>
                        <div class="line-action-gutter">
                            <button class="apply-change-button" data-file-index="${fileIndex}" data-hunk-ids="${hunkIds}">Apply</button>
                        </div>
                    </div>`;

                } else {
                    if (lineIndex < fileLines.length) {
                        contentHtml += `<div class="line-container">
                            <div class="line-numbers-gutter"><span class="line-num-old">${oldLineNum}</span><span class="line-num-new">${newLineNum}</span></div>
                            <div class="line-content-main">${escapeHtml(fileLines[lineIndex] || ' ')}</div>
                            <div class="line-action-gutter"></div>
                        </div>`;
                    }
                    oldLineNum++;
                    newLineNum++;
                }
            }
            contentHtml += '</div>';
            const totalChanges = Object.keys(lineDetails).length;

            return `<details class="file-item" data-file-path="${filePath}" data-file-index="${fileIndex}" open>
                <summary class="file-header">
                    <span class="file-path">${path.basename(filePath)}</span>
                    <span class="dropdown-arrow"></span>
                    <span class="file-summary" data-file-index="${fileIndex}">${totalChanges} changes</span>
                    <div class="file-header-buttons">
                        <button class="jump-to-file-button" data-file-path="${filePath}">View File</button>
                        <button class="view-diff-button" data-file-path="${filePath}">View Diff</button>
                        <button class="apply-file-button" data-file-path="${filePath}">Apply All</button>
                    </div>
                </summary>
                ${contentHtml}
            </details>`;
        } catch (error) {
            logger.error(`Error generating file item HTML for ${change.uri.fsPath}: ${error}`);
            return `<div class="file-item error">Could not load preview for ${path.basename(change.uri.fsPath)}.</div>`;
        }
    }

    private generateScript(filesJson: string): string {
        return `<script>
            // // Log the state of the Webview
            function debugState() {
                console.log('Total file items:', document.querySelectorAll('.file-item').length);
            }

            const vscode = acquireVsCodeApi();
            const files = ${filesJson};

            document.addEventListener('DOMContentLoaded', () => {
                // // Handle jump to file buttons
                document.querySelectorAll('.jump-to-file-button').forEach(button => {
                    button.addEventListener('click', (e) => {
                        e.preventDefault();
                        const filePath = button.getAttribute('data-file-path');
                        vscode.postMessage({
                            command: 'jumpToFile',
                            filePath
                        });
                    });
                });

                // // Handle view diff buttons
                document.querySelectorAll('.view-diff-button').forEach(button => {
                    button.addEventListener('click', (e) => {
                        e.preventDefault();
                        const filePath = button.getAttribute('data-file-path');
                        vscode.postMessage({
                            command: 'viewDiff',
                            filePath
                        });
                    });
                });

                // // Handle apply file changes buttons
                document.querySelectorAll('.apply-file-button').forEach(button => {
                   button.addEventListener('click', (e) => {
                        e.preventDefault();
                        const filePath = button.getAttribute('data-file-path');
                        vscode.postMessage({
                            command: 'applyFileChanges',
                            filePath
                        });

                        // // Visually disable the file item
                        const fileItem = button.closest('.file-item');
                        if (fileItem) {
                            fileItem.style.opacity = '0.6';
                            fileItem.querySelectorAll('button').forEach(btn => btn.disabled = true);
                            fileItem.querySelectorAll('.apply-change-button').forEach(applyBtn => {applyBtn.textContent = 'Applied';});
                        }
                    });
                });

                // // Handle apply all changes button
                document.querySelector('.apply-all-button').addEventListener('click', () => {
                    const allFiles = files.map(file => ({
                        path: file.path,
                        selectedHunks: file.hunks
                    }));

                    vscode.postMessage({
                        command: 'applyChanges',
                        files: allFiles
                    });
                });

                // // Handle apply change buttons
                document.querySelectorAll('.apply-change-button').forEach(button => {
                    button.addEventListener('click', (e) => {
                        e.preventDefault();
                        const hunkIds = button.getAttribute('data-hunk-ids').split(',').map(id => parseInt(id));
                        const fileIndex = parseInt(button.getAttribute('data-file-index'));
                        const filePath = files[fileIndex].path;

                        vscode.postMessage({
                            command: 'applySingleChange',
                            filePath: filePath,
                            hunkId: hunkIds[0],
                        });

                        button.disabled = true;
                        button.textContent = 'Applied';
                        const region = button.closest('.change-region');
                        if (region) {
                            region.style.opacity = '0.6';
                        }
                    });
                });

                // // Handle cancel button
                document.querySelector('.cancel-button').addEventListener('click', () => {
                    vscode.postMessage({
                        command: 'cancel'
                    });
                });
            });
        </script>`;
    }
}
