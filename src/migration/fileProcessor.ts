import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../services/logging';
import { MigrationChange } from '../services/migrationState';



export class FileProcessor { // update this
    public async findPythonFiles(workspacePath: string): Promise<{ pythonFiles: vscode.Uri[], requirementsFiles: vscode.Uri[] }> {
        logger.info('Finding Python files in workspace');
        let pythonFiles = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspacePath, '**/*.py'),
            '{**/node_modules/**,**/.venv/**,**/venv/**,**/.git/**,**/site-packages/**,**/__pycache__/**,**/\\.pytest_cache/**,**/\\.tox/**,**/\\.mypy_cache/**}'
        );
        pythonFiles = pythonFiles.filter(file => !file.fsPath.endsWith('_run_tests_.py')); // ignore auto-generated file // check this for dupe

        const requirementsFiles = await vscode.workspace.findFiles(new vscode.RelativePattern(workspacePath, '**/requirements.txt'));

        logger.info(`Found ${pythonFiles.length} Python files and ${requirementsFiles.length} requirements files`);
        return { pythonFiles, requirementsFiles };
    }

    public copyToTempDir(files: vscode.Uri[], workspacePath: string, tempDir: string): void {
        logger.info(`Copying ${files.length} files to temporary directory`);
        for (const fileUri of files) {
            const relativePath = path.relative(workspacePath, fileUri.fsPath);
            const tempFilePath = path.join(tempDir, relativePath);
            fs.mkdirSync(path.dirname(tempFilePath), { recursive: true });
            const content = fs.readFileSync(fileUri.fsPath, 'utf8');
            fs.writeFileSync(tempFilePath, content);
        }
        logger.info('Files copied successfully');
    }

    public compareFiles(comparisonFiles: vscode.Uri[], workspacePath: string, comparePath: string, isReversed: boolean = false): Omit<MigrationChange, 'hunks'>[] {
        logger.info(`Comparing files between workspace and ${isReversed ? 'premigration backup' : 'temporary directory'}`);
        const changes: Omit<MigrationChange, 'hunks'>[] = [];

        for (const fileUri of comparisonFiles) {
            if (fileUri.fsPath.endsWith('_run_tests_.py')) {continue;} // check this for dupe

            const relativePath = path.relative(workspacePath, fileUri.fsPath);
            const compareFilePath = path.join(comparePath, relativePath);

            if (!fs.existsSync(compareFilePath)) {continue;}

            // // Try reading the backup/temp files
            let workspaceContent: string;
            let compareContent: string;
            try {
                workspaceContent = fs.readFileSync(fileUri.fsPath, 'utf8');
                compareContent = fs.readFileSync(compareFilePath, 'utf8');
            } catch (err) {
                logger.warn(`Failed to read file content: ${err}`);
                continue;
            }

            // // Assign original and updated
            const originalContent = isReversed ? compareContent : workspaceContent;
            const updatedContent = isReversed ? workspaceContent : compareContent;
            if (originalContent !== updatedContent) {
                changes.push({
                    uri: fileUri,
                    originalContent,
                    updatedContent
                });
            }
        }

        logger.info(`Found ${changes.length} files with changes`);
        return changes;
    }
}
