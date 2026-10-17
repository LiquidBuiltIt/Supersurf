import { execFileSync } from 'node:child_process';

// Test fixtures use example.com (reserved by RFC 2606) only. The old
// shorthand was a real, registered domain nobody on this project controls.
const BANNED = String.raw`(?<![\w.-])ex\.com`;

describe('test fixture domains', () => {
  it('no tracked file uses the banned shorthand domain', () => {
    let hits = '';
    try {
      hits = execFileSync('git', ['grep', '-nP', BANNED, '--', '.', ':!**/dist/**', ':!CHANGELOG.md'], {
        encoding: 'utf8',
      });
    } catch (e: any) {
      if (e.status !== 1) throw e; // 1 = no matches
    }
    expect(hits).toBe('');
  });
});
