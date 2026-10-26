import { execFileSync, spawnSync } from 'node:child_process';
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

describe('tracked dist', () => {
  const ls = (p: string) => execFileSync('git', ['ls-files', p], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);

  it('tracks no shared, daemon or server build output', () => {
    expect([...ls('shared/dist'), ...ls('daemon/dist'), ...ls('server/dist')]).toEqual([]);
  });

  it('ignores shared, daemon and server build output', () => {
    for (const f of ['shared/dist/index.js', 'daemon/dist/main.js', 'server/dist/cli.js'])
      expect(spawnSync('git', ['check-ignore', '-q', f], { cwd: root }).status, f).toBe(0);
  });

  it('keeps extension/dist tracked: installed daemons pull it from the latest tag tarball', () => {
    expect(ls('extension/dist')).toContain('extension/dist/background.js');
  });
});
