import * as vscode from 'vscode';
import { expect } from 'chai';

suite('Diff Preview - replace preserves blank line', () => {
  test('head-of-file replace keeps following blank line', async () => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(
      vscode.workspace.workspaceFolders![0].uri.fsPath + '/sample.py'
    ));
    await vscode.window.showTextDocument(doc);

    // Arrange: ensure file content (LF for determinism)
    const original = `import requests\n\nprint("x")\n`;
    await vscode.workspace.fs.writeFile(doc.uri, Buffer.from(original, 'utf8'));
    await doc.save();

    // Act: call your command that builds WorkspaceEdit and applies preview.
    // IMPORTANT: To make this testable, expose a tiny test hook that only BUILDS the edit.
    const build = (vscode.extensions.getExtension('<your.publisher.id>')!
      .exports || {})['__test_buildWorkspaceEditForCurrentFile'];
    expect(build, 'Missing test hook').to.be.a('function');

    const edit: vscode.WorkspaceEdit = await build({
      // supply the same mock change your command uses
      uri: doc.uri,
      originalContent: original,
      updatedContent: `import httpx\n\nprint("x")\n`
    });

    // Apply WITHOUT refactor preview so the text actually changes for assertion
    const applied = await vscode.workspace.applyEdit(edit);
    expect(applied).to.equal(true);

    const updatedText = (await vscode.workspace.openTextDocument(doc.uri)).getText();
    expect(updatedText).to.equal(`import httpx\n\nprint("x")\n`);
  });
});
