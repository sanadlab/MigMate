import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logger } from './logging';

let currentPanel: vscode.WebviewPanel | undefined = undefined;

interface MigrationDetails {
    repoName: string;
    sourceLib: string;
    targetLib: string;
    versions?: {
        source?: string;
        target?: string;
    }
    commit?: string;
    timestamp?: string;
}

export interface TestFailure {
    file: string;
    name: string;
    message: string;
    round: string;
}

export interface TestResults {
    hasFailures: boolean;
    failureCount: number;
    failures: TestFailure[];
    roundResults: Map<string, {passed: number, failed: number, skipped: number}>;
    logContent?: string;
    migrationDetails?: MigrationDetails
}

// // Check test results in the LibMig output directory
export async function checkTestResults(baseDir: string): Promise<TestResults> {
    // // Check for .libmig directory
    let libmigDir: string;
    if (path.basename(baseDir) === '.libmig') {
        libmigDir = baseDir;
    } else {
        libmigDir = path.join(baseDir, '.libmig');
    }

    const results: TestResults = {
        hasFailures: false,
        failureCount: 0,
        failures: [],
        roundResults: new Map(),
        migrationDetails: undefined
    };

    if (!fs.existsSync(libmigDir)) {
        logger.warn(`No .libmig directory found at path: ${libmigDir}`);
        return results;
    }
    logger.info(`Searching for test results in: ${libmigDir}`);
    results.migrationDetails = getMigrationDetails(libmigDir);

    // // Try to read the log.md file // check this
    const logPath = path.join(libmigDir, 'log.md');
    if (fs.existsSync(logPath)) {
        results.logContent = fs.readFileSync(logPath, 'utf8');
    }

    // // Possible round directories
    const rounds = [
        '0-premig',
        '1-llmmig',
        '2-merge_skipped',
        '3-async_transform',
        '4-manual_edit'
    ];

    // // Look for test reports in each round directory
    for (const round of rounds) {
        const roundDir = path.join(libmigDir, round);
        if (!fs.existsSync(roundDir)) {
            continue;
        }

        // // Prioritize the JSON test report
        const jsonReportPath = path.join(roundDir, 'test-report.json');
        if (fs.existsSync(jsonReportPath)) {
            try {
                const reportContent = fs.readFileSync(jsonReportPath, 'utf8');
                const jsonReport = JSON.parse(reportContent);

                // // Parse the JSON report to extract test failures
                const failures = parseJsonTestReport(jsonReport, round);
                results.failures.push(...failures);

                // // Update round summary
                results.roundResults.set(round, {
                    passed: jsonReport.summary?.passed || 0,
                    failed: jsonReport.summary?.failed || 0,
                    skipped: jsonReport.summary?.skipped || 0
                });

                if (failures.length > 0) {
                    results.hasFailures = true;
                    results.failureCount += failures.length;
                }

                continue; // // Skip to next round if JSON parsing worked
            } catch (e) {
                console.error(`Error parsing JSON report for ${round}:`, e);
            }
        }

        // // Try XML report next
        const xmlReportPath = path.join(roundDir, 'test-report.xml');
        if (fs.existsSync(xmlReportPath)) {
            // // Just use regex for parsing
            const xmlContent = fs.readFileSync(xmlReportPath, 'utf8');
            const testcaseRegex = /<testcase\b([^>]*)\/>|<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g;
            let testcaseMatch;
            let passedCount = 0, failedCount = 0, skippedCount = 0;

            while ((testcaseMatch = testcaseRegex.exec(xmlContent)) !== null) {
                const attrs = testcaseMatch[1] || testcaseMatch[2];
                const inner = testcaseMatch[3] || '';
                const nameMatch = attrs.match(/name="(.*?)"/);
                const classnameMatch = attrs.match(/classname="(.*?)"/);
                const name = nameMatch ? nameMatch[1] : 'unknown';
                const file = classnameMatch ? classnameMatch[1] : 'unknown';

                if (/<failure\b/.test(inner)) {
                    failedCount++;
                    const failureMsgMatch = inner.match(/<failure[^>]*message="([^"]*)"/);
                    const failureMsg = failureMsgMatch ? failureMsgMatch[1] : 'Test failed';
                    results.failures.push({
                        name,
                        file,
                        message: failureMsg,
                        round
                    });
                    results.hasFailures = true;
                    results.failureCount++;
                } else if (/<skipped\b/.test(inner)) {
                    skippedCount++;
                } else {
                    passedCount++;
                }
            }

            // // Add round summary
            results.roundResults.set(round, {
                passed: passedCount,
                failed: failedCount,
                skipped: skippedCount
            });
        }
    }
    return results;
}

// // Parse pytest-json-report format to extract failures
function parseJsonTestReport(report: any, round: string): TestFailure[] {
    const failures: TestFailure[] = [];

    // // Handle different JSON report formats
    if (report.tests) {
        // // Format with top-level tests array
        for (const test of report.tests) {
            if (test.outcome === 'failed') {
                failures.push({
                    file: test.nodeid.split('::')[0],
                    name: test.nodeid.split('::').slice(1).join('::'),
                    message: test.call?.longrepr || 'Test failed',
                    round
                });
            }
        }
    } else if (report.report && report.report.tests) {
        // // Alternative format
        for (const [testId, testData] of Object.entries<any>(report.report.tests)) {
            if (testData.outcome === 'failed') {
                const parts = testId.split('::');
                failures.push({
                    file: parts[0],
                    name: parts.slice(1).join('::'),
                    message: testData.call?.longrepr || 'Test failed',
                    round
                });
            }
        }
    }

    return failures;
}

// // Pull additional migration details from 'report.yaml'
function getMigrationDetails(libmigDir: string): MigrationDetails | undefined {
    try {
        // // Find report path
        const reportPath = path.join(libmigDir, 'report.yaml');
        if (!fs.existsSync(reportPath)) {
            logger.warn(`No report.yaml found in ${libmigDir}`);
            return undefined;
        }
        const reportContent = fs.readFileSync(reportPath, 'utf8');

        // // Regex parsing
        const repoMatch = /^repo: (.+)$/m.exec(reportContent);
        const commitMatch = /^commit: (.+)$/m.exec(reportContent);
        const sourceMatch = /^source: (.+)$/m.exec(reportContent);
        const targetMatch = /^target: (.+)$/m.exec(reportContent);
        const sourceVersionMatch = /source_version: (.*?)/.exec(reportContent);
        const targetVersionMatch = /target_version: (.*?)/.exec(reportContent);
        const timestampMatch = /finished_at: ['"](.+?)['"]/.exec(reportContent);

        return {
            repoName: repoMatch?.[1] || 'Unknown',
            commit: commitMatch?.[1],
            sourceLib: sourceMatch?.[1] || 'Unknown',
            targetLib: targetMatch?.[1] || 'Unknown',
            versions: {
                source: sourceVersionMatch?.[1],
                target: targetVersionMatch?.[1]
            },
            timestamp: timestampMatch?.[1]
        };
    } catch (error) {
        logger.error(`Error parsing migration details: ${error}`);
        return undefined;
    }
}

// // Show test results in a WebView panel
export function showTestResultsDetail(results: TestResults): void {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    // // Show existing webview panel
    if (currentPanel) {
        currentPanel.reveal(column);
        currentPanel.webview.html = generateTestResultsHtml(results);
        return;
    }

    // // Create and show new webview
    currentPanel = vscode.window.createWebviewPanel(
        'libmigTestResults',
        'Migration Test Results',
        column || vscode.ViewColumn.One,
        { enableScripts: true }
    );
    currentPanel.webview.html = generateTestResultsHtml(results);

    // // Triggers
    currentPanel.onDidDispose(() => {currentPanel = undefined;}, null);
    currentPanel.webview.onDidReceiveMessage(
        async message => {
            switch(message.command) {
                case 'jumpToFile':
                    try {
                        const workspaceFolders = vscode.workspace.workspaceFolders;
                        if (!workspaceFolders) {
                            logger.error(`Failed to open file from webview: No open workspace`);
                            vscode.window.showErrorMessage("Cannot jump to file, no workspace is open.");
                            return;
                        }
                        const workspaceRoot = workspaceFolders[0].uri;
                        const fileUri = vscode.Uri.joinPath(workspaceRoot, message.filepath);
                        await vscode.window.showTextDocument(fileUri, { preview: false });
                    } catch (error) {
                        logger.error(`Failed to open file from webview: ${error}`);
                        vscode.window.showErrorMessage(`Could not open file: ${message.filepath}`);
                    }
            }
        }
    );
}

// // Generate HTML for displaying test results
function generateTestResultsHtml(results: TestResults): string {
    let migrationInfoHtml = '';
    if (results.migrationDetails) {
        const details = results.migrationDetails;
        // const sourceText = details.versions?.source
        //     ? `${details.sourceLib} (${details.versions.source})`
        //     : details.sourceLib;
        // const targetText = details.versions?.target
        //     ? `${details.targetLib} (${details.versions.target})`
        //     : details.targetLib;
        migrationInfoHtml = `
        <div class="migration-info">
            <div class="info-grid">
                <div class="info-item">
                    <span class="info-label">Repository:</span>
                    <span class="info-value">${details.repoName || 'N/A'}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Migration:</span>
                    <span class="info-value">${details.sourceLib || 'Unknown'} → ${details.targetLib || 'Unknown'}</span>
                </div>
                ${details.versions?.source ? `
                <div class="info-item">
                    <span class="info-label">Source Version:</span>
                    <span class="info-value">${details.versions.source}</span>
                </div>` : ''}
                ${details.versions?.target ? `
                <div class="info-item">
                    <span class="info-label">Target Version:</span>
                    <span class="info-value">${details.versions.target}</span>
                </div>` : ''}
                ${details.timestamp ? `
                <div class="info-item">
                    <span class="info-label">Migration Started:</span>
                    <span class="info-value">${details.timestamp}</span>
                </div>` : ''}
            </div>
        </div>`;
    }

    let roundsHtml = '';
    results.roundResults.forEach((stats, round) => {
        roundsHtml += `
            <div class="round">
                <h3>${formatRoundName(round)}</h3>
                <div class="stats">
                    <span class="passed">Passed: ${stats.passed}</span>
                    <span class="failed">Failed: ${stats.failed}</span>
                    <span class="skipped">Skipped: ${stats.skipped}</span>
                </div>
            </div>
        `;
    });

    let failuresHtml = '';
    results.failures.forEach(failure => {
        const failureId = `failure-${failure.round}-${failure.file}-${failure.name}`.replace(/[^a-zA-Z0-9-_]/g, '-');
        failuresHtml += `
            <details id="${failureId}" class="failure" open>
                <summary class="failure-header">
                    <span class="dropdown-arrow"></span>
                    <span class="failure-round">${formatRoundName(failure.round)}</span>
                    <span class="failure-file">${failure.file}</span>
                    <span class="failure-name">${failure.name}</span>
                    <button class="jump-button" data-filepath="${escapeHtml(failure.file)}">Go</button>
                </summary>
                <pre class="failure-message">${escapeHtml(failure.message)}</pre>
            </details>
        `;
    });

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Migration Test Results</title>
        <style>
            body {
                color: var(--vscode-editor-foreground);
                background: var(--vscode-editor-background);
                font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif);
                padding: 20px;
            }
            h2 {
                color: var(--vscode-editor-foreground);
                border-bottom: 1px solid var(--vscode-panel-border, #444);
                padding-bottom: 10px;
            }
            .summary {
                margin-bottom: 20px;
                font-size: 1.2em;
            }
            .rounds {
                display: flex;
                flex-wrap: wrap;
                gap: 15px;
                margin-bottom: 20px;
            }
            .round {
                background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editorWidget-background, #222));
                border: 1px solid var(--vscode-panel-border, #444);
                border-radius: 5px;
                padding: 10px;
                min-width: 200px;
                box-shadow: 0 1px 4px 0 rgba(0,0,0,0.07);
            }
            .round h3 {
                margin-top: 0;
                color: var(--vscode-editor-foreground);
            }
            .stats {
                display: flex;
                gap: 10px;
            }
            .passed {
                color: var(--vscode-testing-iconPassed, #4bb543);
                font-weight: bold;
            }
            .failed {
                color: var(--vscode-testing-iconFailed, #f14c4c);
                font-weight: bold;
            }
            .skipped {
                color: var(--vscode-testing-iconSkipped, #cca700);
                font-weight: bold;
            }
            .failures {
                margin-top: 30px;
            }
            .failure {
                background: var(--vscode-editorError-background, #2d2d2d);
                border-left: 3px solid var(--vscode-testing-iconFailed, #f14c4c);
                padding: 10px;
                margin-bottom: 15px;
                border-radius: 3px;
                box-shadow: 0 1px 4px 0 rgba(0,0,0,0.10);
            }
            .failure-header {
                display: flex;
                margin-bottom: 5px;
                align-items: center;
                gap: 5px;
                cursor: pointer;
                list-style: none;
            }
            .failure-header::-webkit-details-marker {
                display: none;
            }
            .dropdown-arrow {
                width: 0;
                height: 0;
                border-top: 5px solid transparent;
                border-bottom: 5px solid transparent;
                border-left: 5px solid currentColor;
                transition: transform 0.2s ease-in-out;
                margin-right: 5px;
            }
            .failure[open] > .failure-header .dropdown-arrow {
                transform: rotate(90deg);
            }
            .failure-round {
                background: var(--vscode-badge-background, #444);
                color: var(--vscode-badge-foreground, #fff);
                padding: 2px 6px;
                border-radius: 3px;
                font-size: 0.95em;
            }
            .failure-file {
                color: var(--vscode-descriptionForeground, #aaa);
                margin-right: auto;
                font-size: 0.95em;
            }
            .failure-name {
                font-weight: bold;
                color: var(--vscode-editor-foreground);
            }
            .failure-message {
                background: var(--vscode-editorWidget-background, #181818);
                color: var(--vscode-editor-foreground, #eee);
                padding: 10px;
                border-radius: 3px;
                overflow-x: auto;
                font-size: 0.98em;
                border: 1px solid var(--vscode-panel-border, #444);
                margin-top: 10px;
            }
            .jump-button {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: 1px solid var(--vscode-button-border, transparent);
                border-radius: 3px;
                padding: 3px 12px;
                cursor: pointer;
                font-size: 0.9em;
            }
            .jump-button:hover {
                background: var(--vscode-button-hoverBackground);
            }

            .log {
                margin-top: 30px;
                padding: 15px;
                background: var(--vscode-editorWidget-background, #181818);
                border-radius: 5px;
                max-height: 300px;
                overflow-y: auto;
                white-space: pre-wrap;
                color: var(--vscode-editor-foreground, #eee);
                border: 1px solid var(--vscode-panel-border, #444);
            }

            .migration-info {
                background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editorWidget-background, #222));
                border: 1px solid var(--vscode-panel-border, #444);
                border-radius: 5px;
                padding: 15px;
                margin-bottom: 20px;
                box-shadow: 0 1px 4px 0 rgba(0,0,0,0.07);
            }
            .migration-info h3 {
                margin-top: 0;
                margin-bottom: 10px;
                color: var(--vscode-editor-foreground);
            }
            .info-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
                grid-gap: 10px;
            }
            .info-item {
                display: flex;
                flex-direction: column;
            }
            .info-label {
                font-size: 0.9em;
                color: var(--vscode-descriptionForeground, #aaa);
            }
            .info-value {
                font-weight: bold;
                color: var(--vscode-editor-foreground);
            }
        </style>
    </head>
    <body>
        ${migrationInfoHtml}
        <h2>Migration Test Results</h2>
        <div class="summary">
            ${results.failureCount > 0
                ? `<span class="failed">❌ ${results.failureCount} test${results.failureCount !== 1 ? 's' : ''} failed</span>`
                : results.roundResults.size > 0
                    ? '<span class="passed">✅ All tests passed</span>'
                    : '<span class="skipped">No test results found</span>'
                }
        </div>

        <h3>Results by Migration Round</h3>
        <div class="rounds">
            ${roundsHtml || '<p>No round data available</p>'}
        </div>

        ${results.failureCount > 0 ? `
            <h3>Test Failures</h3>
            <div class="failures">
                ${failuresHtml}
            </div>
        ` : ''}

        ${results.logContent ? `
            <h3>Migration Log</h3>
            <div class="log">${escapeHtml(results.logContent)}</div>
        ` : ''}

        <script>
            const vscode = acquireVsCodeApi();
            const previousState = vscode.getState() || { openStates: {} };
            document.addEventListener('DOMContentLoaded', function () {
                document.querySelectorAll('details.failure').forEach(detailsElement => {
                    // // Close failure details based on previous state
                    const id = detailsElement.id;
                    if (!id) return;
                    if (previousState.openStates[id] === false) {
                        detailsElement.removeAttribute('open');
                    }
                    // // Save the new toggle state
                    detailsElement.addEventListener('toggle', (event) => {
                        previousState.openStates[id] = detailsElement.open;
                        vscode.setState(previousState);
                    });
                });

                // // Add listeners for jump buttons
                document.querySelectorAll('.jump-button').forEach(button => {
                    button.addEventListener('click', (event) => {
                        event.stopPropagation();
                        const filepath = button.getAttribute('data-filepath');
                        if (filepath) {
                            vscode.postMessage({
                                command: 'jumpToFile',
                                filepath: filepath
                            });
                        }
                    });
                });
            });
        </script>
    </body>
    </html>`;
}

// // Format round name for display
function formatRoundName(round: string): string {
    switch(round) {
        case '0-premig': return 'Pre-Migration';
        case '1-llmmig': return 'LLM Migration';
        case '2-merge-skipped': return 'Merge Skipped';
        case '3-async_transform': return 'Async Transform';
        case '4-manual_edit': return 'Manual Edit';
        default: return round;
    }
}

// // Escape HTML for safety
function escapeHtml(unsafe: string): string {
    return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// // WIP to check CLI output for failures (use as backup? or maybe for non-test failure issues?)
function parseCliOutput(buffer: string) {}
