import { expect } from 'chai';
import { migrationState } from '../../migration/migrationState';

describe('MigrationStateService', () => {
  it('should detect added lines', () => {
    const original = 'a\nb\nc';
    const updated = 'a\nb\nc\nd';
    const hunks = (migrationState as any).parseDiff(original, updated);
    expect(hunks.some((h: any) => h.type === 'added')).to.be.true;
  });

  // Add more tests for removed, replaced, EOL, etc.
});



// function lf(s: string){ return s.replace(/\r\n/g, '\n'); }
// describe('diff hunks', () => {
//   it('pairs a head-of-file replace and preserves following blank line', () => {
//     const original = lf(`import requests\n\nprint("x")\n`);
//     const updated  = lf(`import httpx\n\nprint("x")\n`);

//     const hunks = migrationState.parseDiff(original, updated);

//     // Expect REMOVED followed immediately by ADDED at same line
//     expect(hunks[0].type).to.equal('removed');
//     expect(hunks[1].type).to.equal('added');
//     expect(hunks[0].originalStartLine).to.equal(0);
//     expect(hunks[1].originalStartLine).to.equal(0);

//     // Lines are correct
//     expect(hunks[0].lines.join('\n')).to.equal('import requests');
//     expect(hunks[1].lines.join('\n')).to.equal('import httpx');
//   });

//   it('handles CRLF vs LF as the same for diffing', () => {
//     const original = `a\r\n\r\nb\r\n`;
//     const updated  = `a\r\n\r\nB\r\n`;
//     const hunks = migrationState.parseDiff(original, updated);
//     // Should be one replacement (removed then added) anchored at line 2 (0-based)
//     expect(hunks.some(h => h.originalStartLine === 2)).to.be.true;
//   });
// });




suite('MigrationState Service', () => {
    test('Should parse diffs correctly', () => {
        // Use any for accessing private method
        const privateMethod = (migrationState as any).parseDiff;

        // Test with sample content
        const original = 'import requests\n\nresp = requests.get("https://example.com")';
        const updated = 'import httpx\n\nresp = httpx.get("https://example.com")';

        const hunks = privateMethod(original, updated);

        // Verify hunks structure
        expect(hunks).to.be.an('array');
        expect(hunks.length).to.be.at.least(2); // At least remove and add hunks

        // Check for expected changes
        const removeHunk = hunks.find((h: any) => h.type === 'removed' && h.lines[0].includes('requests'));
        const addHunk = hunks.find((h: any) => h.type === 'added' && h.lines[0].includes('httpx'));

        expect(removeHunk).to.exist;
        expect(addHunk).to.exist;
    });
});
