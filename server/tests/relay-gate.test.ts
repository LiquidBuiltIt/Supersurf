/**
 * The `server.legacy` gate (default true; false = relay) on the BUILT `supersurf-mcp` bin (E5). Off is today's Node server with
 * no new output; on hands the process to `supersurf-server` (execve: same pid) with the resolved
 * port first; script mode never relays. The shim is a recording script.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { makeRig, runServer, type Rig } from './helpers/relay-rig';

const PORT = '6123';
const hasExecve = typeof (process as any).execve === 'function';

let rig: Rig;
afterEach(() => rig?.cleanup());

function ran(rec: { pid: string }): boolean { return fs.existsSync(rec.pid); }
function argvOf(rec: { argv: string }): string[] { return fs.readFileSync(rec.argv, 'utf8').trimEnd().split('\n'); }

describe('relay gate: switch off', () => {
  it('runs the Node server, never runs the shim, prints nothing about the relay', async () => {
    rig = makeRig();
    const rec = rig.recorder();
    const r = await runServer(['--port', PORT], rig.env({ SUPERSURF_SERVER_BIN: rec.bin }));
    expect(r.initReply?.result?.serverInfo?.name).toBe('SuperSurf');
    expect(ran(rec)).toBe(false);
    expect(r.stderr).not.toMatch(/relay|supersurf-server/i);
    expect(fs.existsSync(path.join(rig.home, '.supersurf', 'daemon', 'entry'))).toBe(false);
  });
});

describe('relay gate: switch on with a binary', () => {
  const cases: [string, string[], Record<string, string>, (rig: Rig) => void][] = [
    ['SUPERSURF_DISABLE_LEGACY_SERVER=1', ['--port', PORT], { SUPERSURF_DISABLE_LEGACY_SERVER: '1' }, () => {}],
    ['--disable-legacy-server flag', ['--disable-legacy-server', '--port', PORT], {}, () => {}],
    ['server.legacy in the config file', ['--port', PORT], {}, (r) => fs.writeFileSync(r.config, JSON.stringify({ server: { legacy: false } }))],
  ];
  for (const [name, args, env, setup] of cases) {
    it(`${name}: the shim runs with --port first and its exit code is the process exit code`, async () => {
      rig = makeRig();
      setup(rig);
      const rec = rig.recorder(7);
      const r = await runServer(args, rig.env({ SUPERSURF_SERVER_BIN: rec.bin, ...env }));
      expect(r.code).toBe(7);
      expect(argvOf(rec).slice(0, 2)).toEqual(['--port', PORT]);
      expect(r.initReply).toBeNull();
      expect(r.stderr).toBe('');
    });
  }

  it.skipIf(!hasExecve)('execve: the shim runs under the server process pid', async () => {
    rig = makeRig();
    const rec = rig.recorder(0);
    const r = await runServer(['--disable-legacy-server', '--port', PORT], rig.env({ SUPERSURF_SERVER_BIN: rec.bin }));
    expect(Number(fs.readFileSync(rec.pid, 'utf8'))).toBe(r.pid);
  });

  it('passes only the shim flags, after dropping the legacy `mcp` positional', async () => {
    rig = makeRig();
    const rec = rig.recorder();
    await runServer(['mcp', '--disable-legacy-server', '--port', PORT, '--multi-agent', '--debug', 'no_truncate', '--log-file', '/x.log', '--disable-secure-eval'],
      rig.env({ SUPERSURF_SERVER_BIN: rec.bin }));
    expect(argvOf(rec)).toEqual(['--port', PORT, '--multi-agent', '--debug', '--disable-secure-eval']);
  });

  it('uses the default port when none is given', async () => {
    rig = makeRig();
    const rec = rig.recorder();
    await runServer([], rig.env({ SUPERSURF_SERVER_BIN: rec.bin, SUPERSURF_DISABLE_LEGACY_SERVER: '1' }));
    expect(argvOf(rec)).toEqual(['--port', '5555']);
  });

  it('does not relay in --script-mode', async () => {
    rig = makeRig();
    const rec = rig.recorder();
    const r = await runServer(['--script-mode', '--disable-legacy-server'], rig.env({ SUPERSURF_SERVER_BIN: rec.bin, SUPERSURF_DISABLE_LEGACY_SERVER: '1' }));
    expect(ran(rec)).toBe(false);
    expect(fs.existsSync(rec.argv)).toBe(false);
    expect(r.initReply?.id).toBe(1); // script mode answered the JSON-RPC line itself
  });

  it('does not relay in the hot-reload child (--child)', async () => {
    rig = makeRig();
    const rec = rig.recorder();
    await runServer(['--child', '--disable-legacy-server'], rig.env({ SUPERSURF_SERVER_BIN: rec.bin }));
    expect(ran(rec)).toBe(false);
  });
});

describe('relay gate: switch on, binary missing', () => {
  // A shim built with `npm run build.shim` sits at <server>/bin/<goos>-<goarch>/ and would be found, so a
  // preload makes the server's own bin/ look empty to the BUILT bin (the same branch as a missing binary).
  it('warns once on stderr and runs the Node server', async () => {
    rig = makeRig();
    const hide = path.join(rig.home, 'hide-bin.js');
    const serverBin = path.resolve(__dirname, '..', 'bin') + path.sep;
    fs.writeFileSync(hide, `const fs = require('fs'); const hidden = (p) => String(p).startsWith(${JSON.stringify(serverBin)});
for (const f of ['accessSync', 'statSync']) { const o = fs[f]; fs[f] = function (p, ...a) { if (hidden(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return o.call(this, p, ...a); }; }\n`);
    const r = await runServer(['--disable-legacy-server', '--port', PORT], rig.env({ SUPERSURF_SERVER_BIN: path.join(rig.home, 'absent'), NODE_OPTIONS: `--require ${hide}` }));
    expect(r.initReply?.result?.serverInfo?.name).toBe('SuperSurf');
    const lines = r.stderr.split('\n').filter((l) => /server\.legacy/.test(l));
    expect(lines).toEqual(['[supersurf] server.legacy is false but supersurf-server was not found (set SUPERSURF_SERVER_BIN, or install a SuperSurf build that ships it); running the Node server.']);
  });
});

describe('relay gate: the binary does not run', () => {
  it('warns once naming the error and runs the Node server', async () => {
    rig = makeRig();
    // Executable but not a program: process.execve would abort the process, so the probe must catch it first.
    const bin = path.join(rig.home, 'bad-shim');
    fs.writeFileSync(bin, 'not a program\n', { mode: 0o755 });
    const r = await runServer(['--disable-legacy-server', '--port', PORT], rig.env({ SUPERSURF_SERVER_BIN: bin }));
    expect(r.initReply?.result?.serverInfo?.name).toBe('SuperSurf');
    const lines = r.stderr.split('\n').filter((l) => /supersurf-server/.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[supersurf\] could not hand over to supersurf-server: .+; running the Node server\.$/);
  });
});
