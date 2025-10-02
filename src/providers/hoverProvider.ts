import * as vscode from 'vscode';



export function registerHoverProvider(context: vscode.ExtensionContext) {
    const hoverProvider = vscode.languages.registerHoverProvider(
        [
            {language: 'plaintext', pattern: '**/requirements.txt'},
            {language: 'pip-requirements'}
        ],
        {

            // // consider doing something like
            // { language: 'toml', pattern: '**/pyproject.toml' }
            // provideHover(doc, pos) {
            //     if (document.fileName.endsWith('pyproject.toml')) {return ProvideTomlHover(doc, pos)}
            //     if (document.fileName.endsWith('requirements.txt')) {return ProvideRequirementsHover(doc, pos)}
            //     return undefined;
            // }

            provideHover(document, position) {
                const line = document.lineAt(position.line);
                const lineText = line.text.trim();
                if (lineText.startsWith('#') || lineText.length === 0) { // ignore commented/empty lines
                    return undefined;
                }

                const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9\-_]+/);
                if (!wordRange) {return undefined;}
                const hoveredWord = document.getText(wordRange);

                const libNameMatch = lineText.match(/^([a-zA-Z0-9\-_]+)/);
                if (libNameMatch && libNameMatch[1] === hoveredWord) {
                    const libName = libNameMatch[1];
                    console.log(`Hover detected on library: ${libName}`);

                    const markdown = new vscode.MarkdownString(
                        `**LibMig Plugin:**\n\n[Migrate \`${libName}\`](command:libmig.migrate?${JSON.stringify(libName)})`
                    );
                    markdown.isTrusted = true;
                    return new vscode.Hover(markdown, wordRange);
                }
                return undefined;
            }
        }
    );
    context.subscriptions.push(hoverProvider);
}
