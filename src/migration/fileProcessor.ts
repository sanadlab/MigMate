import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../services/logging';
import { MigrationChange } from './migrationState';
import { DiffUtils } from './diffUtils';



export class FileProcessor { // update the file block patterns
    public async findPythonFiles(workspacePath: string): Promise<{ pythonFiles: vscode.Uri[], requirementsFiles: vscode.Uri[] }> {
        logger.info('Finding Python files in workspace...');
        const excludePattern = '{**/.libmig/**,**/node_modules/**,**/.venv/**,**/venv/**,**/.git/**,**/site-packages/**,**/__pycache__/**,**/\\.pytest_cache/**,**/\\.tox/**,**/\\.mypy_cache/**}'
        let pythonFiles = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspacePath, '**/*.py'),
            excludePattern
        );
        pythonFiles = pythonFiles.filter(file => !file.fsPath.endsWith('_run_tests_.py')); // ignore auto-generated file // check this for dupe

        const requirementsFiles = await vscode.workspace.findFiles(new vscode.RelativePattern(workspacePath, '**/requirements.txt')); // check this

        logger.info(`Found ${pythonFiles.length} Python files and ${requirementsFiles.length} requirements files`);
        return { pythonFiles, requirementsFiles };
    }

    public copyToTempDir(files: vscode.Uri[], workspacePath: string, tempDir: string): void {
        logger.info(`Copying ${files.length} files to temporary directory...`);
        for (const fileUri of files) {
            const relativePath = path.relative(workspacePath, fileUri.fsPath);
            const tempFilePath = path.join(tempDir, relativePath);
            fs.mkdirSync(path.dirname(tempFilePath), { recursive: true });
            const content = fs.readFileSync(fileUri.fsPath, 'utf8');
            fs.writeFileSync(tempFilePath, content);
        }
        logger.info('Files copied successfully');
    }

    public compareFiles(comparisonFiles: vscode.Uri[], workspacePath: string, comparePath: string): Omit<MigrationChange, 'hunks'>[] {
        logger.info(`Comparing files in workspace ${workspacePath} against migrated copies in: ${comparePath}`);
        const changes: Omit<MigrationChange, 'hunks'>[] = [];

        for (const fileUri of comparisonFiles) {
            if (fileUri.fsPath.endsWith('_run_tests_.py')) {continue;} // check this for dupe

            const relativePath = path.relative(workspacePath, fileUri.fsPath);
            const compareFilePath = path.join(comparePath, relativePath);
            // console.log(`Comparing original '${relativePath}' to migrated '${compareFilePath}'`);

            if (!fs.existsSync(compareFilePath)) {continue;}

            try {
                const originalContent = fs.readFileSync(fileUri.fsPath, 'utf8');
                const updatedContent = fs.readFileSync(compareFilePath, 'utf8');
                // // Normalize for comparison
                const normalizedOriginal = DiffUtils.normalizeEOL(originalContent);
                const normalizedUpdated = DiffUtils.normalizeEOL(updatedContent);
                if (normalizedOriginal !== normalizedUpdated) {
                    changes.push({
                        uri: fileUri,
                        originalContent,
                        updatedContent
                    });
                }
            } catch (err) {
                logger.warn(`Failed to read file content for comparison: ${err}`);
                continue;
            }
        }

        logger.info(`Found ${changes.length} files with changes`);
        return changes;
    }
}
