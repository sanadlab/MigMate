import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

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
}

// // Check test results in the LibMig output directory
export async function checkTestResults(tempDir: string): Promise<TestResults> {
    const results: TestResults = {
        hasFailures: false,
        failureCount: 0,
        failures: [],
        roundResults: new Map()
    };

    // // Try to read the log.md file
    const logPath = path.join(tempDir, '.libmig', 'log.md');
    if (fs.existsSync(logPath)) {
        results.logContent = fs.readFileSync(logPath, 'utf8');
    }

    // // Check for .libmig directory
    const libmigDir = path.join(tempDir, '.libmig');
    if (!fs.existsSync(libmigDir)) {
        console.log('No .libmig directory found');
        return results;
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

// // Show test results in a WebView panel
export function showTestResultsDetail(results: TestResults): void {
    // // Create and show a webview
    const panel = vscode.window.createWebviewPanel(
        'libmigTestResults',
        'Migration Test Results',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );
    panel.webview.html = generateTestResultsHtml(results);
}

// // Generate HTML for displaying test results
function generateTestResultsHtml(results: TestResults): string {
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
        failuresHtml += `
            <div class="failure">
                <div class="failure-header">
                    <span class="failure-round">${formatRoundName(failure.round)}</span>
                    <span class="failure-file">${failure.file}</span>
                    <span class="failure-name">${failure.name}</span>
                </div>
                <pre class="failure-message">${escapeHtml(failure.message)}</pre>
            </div>
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
                margin-bottom: 10px;
                align-items: center;
            }
            .failure-round {
                background: var(--vscode-badge-background, #444);
                color: var(--vscode-badge-foreground, #fff);
                padding: 2px 6px;
                border-radius: 3px;
                margin-right: 10px;
                font-size: 0.95em;
            }
            .failure-file {
                color: var(--vscode-descriptionForeground, #aaa);
                margin-right: 10px;
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
        </style>
    </head>
    <body>
        <h2>Migration Test Results</h2>
        <div class="summary">
            ${results.failureCount > 0
                ? `<span class="failed">❌ ${results.failureCount} test${results.failureCount !== 1 ? 's' : ''} failed</span>`
                : '<span class="passed">✅ All tests passed</span>'}
        </div>

        <h3>Results by Migration Round</h3>
        <div class="rounds">
            ${roundsHtml || '<p>No round data available</p>'}
        </div>

        ${results.failureCount > 0 ? `
            <div class="failures">
                <h3>Test Failures</h3>
                ${failuresHtml}
            </div>
        ` : ''}

        ${results.logContent ? `
            <h3>Migration Log</h3>
            <div class="log">${escapeHtml(results.logContent)}</div>
        ` : ''}
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
