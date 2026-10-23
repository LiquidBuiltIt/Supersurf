import fs from 'fs';
import path from 'path';
import * as cli from '../src/cli-commands';
import * as main from '../src/main';

const MOVED = ['parseArgs', 'queryDaemonStatus', 'formatUptime', 'getVersion', 'printStatus', 'observe', 'stopDaemon'] as const;

it('exports every CLI subcommand function', () => {
  for (const n of MOVED) expect(typeof cli[n], n).toBe('function');
});

it('main.ts re-exports the same objects, so main.test.ts keeps its seam', () => {
  for (const n of ['parseArgs', 'formatUptime', 'getVersion', 'printStatus', 'observe', 'stopDaemon'] as const)
    expect(main[n], n).toBe(cli[n]);
  expect(main.PID_FILE).toBe(cli.PID_FILE);
  expect(main.SOCK_FILE).toBe(cli.SOCK_FILE);
  expect(main.SUPERSURF_DIR).toBe(cli.SUPERSURF_DIR);
});

it('getVersion still finds daemon/package.json from its new file', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  expect(cli.getVersion()).toBe(pkg.version);
});

it('never imports main.ts, so importing it cannot reach the entry block', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli-commands.ts'), 'utf8');
  expect(src).not.toMatch(/from '\.\/main'/);
  expect(src).not.toMatch(/isDirectRun|\bmain\(\)/);
});
