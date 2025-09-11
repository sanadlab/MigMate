import * as vscode from 'vscode';



export function registerHoverProvider(context: vscode.ExtensionContext) {
    const hoverProvider = vscode.languages.registerHoverProvider(
        [
            {language: 'plaintext', pattern: '**/requirements.txt'},
            {language: 'pip-requirements'}
        ],
        {
            provideHover(document, position) {
                const range = document.getWordRangeAtPosition(position, /[a-zA-Z0-9-_]+/);
                const word = range ? document.getText(range) : null;

                if (word) {
                    console.log(`Hover detected on word: ${word}`);
                    const markdown = new vscode.MarkdownString(
                        `**LibMig Plugin:**\n\n[Migrate \`${word}\`](command:libmig.migrate?${JSON.stringify(word)})`
                    );
                    markdown.isTrusted = true;
                    return new vscode.Hover(markdown);
                }
                return undefined;
            }
        }
    );
    context.subscriptions.push(hoverProvider);
}
