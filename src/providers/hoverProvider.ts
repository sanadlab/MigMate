import * as vscode from 'vscode';



export class HoverProvider implements vscode.HoverProvider {
    public provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
        const line = document.lineAt(position.line);
        const lineText = line.text.trim();
        if (lineText.startsWith('#') || lineText.length === 0) {return undefined;} // ignore commented/empty lines

        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9\-_]+/);
        if (!wordRange) {return undefined;}
        const hoveredWord = document.getText(wordRange);

        const libNameMatch = lineText.match(/^([a-zA-Z0-9\-_]+)/);
        if (libNameMatch && libNameMatch[1] === hoveredWord) {
            const libName = libNameMatch[1];
            // console.log(`Hover detected on library: ${libName}`);

            const markdown = new vscode.MarkdownString(
                `**LibMig Plugin:**\n\n[Migrate \`${libName}\`](command:libmig.migrate?${JSON.stringify(libName)})`
            );
            markdown.isTrusted = true;
            return new vscode.Hover(markdown, wordRange);
        }
        return undefined;
    }
}
