import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// extension/dist/ is tracked. A compiled file whose source is gone, or lives
// under a `.old` name (which must not build), keeps shipping with nothing to explain it.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('extension/dist orphans', () => {
  it('every tracked dist .js has a live, non-.old source under extension/src', () => {
    const tracked = execFileSync('git', ['ls-files', 'extension/dist'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter((f) => f.endsWith('.js'));
    const orphans = tracked.filter((f) => {
      const src = f.replace(/^extension\/dist\//, 'extension/src/').replace(/\.js$/, '.ts');
      return /(^|\/)[^/]*\.old(\.ts)?(\/|$)/.test(src) || !existsSync(join(root, src));
    });
    expect(orphans).toEqual([]);
  });
});
