import * as path from 'path';
import Mocha from 'mocha';
import * as fs from 'fs';

export function run(): Promise<void> {
    // // Create the test
    const mocha = new Mocha({ ui: 'bdd', color: true });
    const testRoot = path.resolve(__dirname, '..');
    // mocha.addFile(path.resolve(__dirname, '../extension.test.js'));

    // // Look for test files instead of adding them manually here (recursive)
    function addTestFiles(dir: string) {
        fs.readdirSync(dir).forEach(file => {
            const fullPath = path.join(dir, file);
            if (fs.statSync(fullPath).isDirectory()) {
                addTestFiles(fullPath);
            }
            else if (file.endsWith('.test.js')) {
                mocha.addFile(fullPath);
            }
        });
    }
    addTestFiles(path.join(testRoot, 'suite'));

    return new Promise<void>((resolve, reject) => {
        try {
            mocha.run((failures: number) => {
                if (failures > 0) {
                    reject(new Error(`${failures} tests failed`));
                }
                else {resolve();}
            });
        }
        catch (err) {
            console.error(err);
            reject(err);
        }
    });
}
