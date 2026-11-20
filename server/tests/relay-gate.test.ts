/**
 * The `agents.relay` gate on the BUILT `supersurf-mcp` bin (E5). Off is today's Node server with
 * no new output; on hands the process to `supersurf-shim` (execve: same pid) with the resolved
 * port first; script mode never relays. The shim is a recording script.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { makeRig, runServer, type Rig } from './helpers/relay-rig';

const PORT = '6123';
const BUILT_SHIM = path.resolve(__dirname, '..', '..', 'daemon', 'bin', 'supersurf-shim');
const hasExecve = typeof (process as any).execve === 'function';

let rig: Rig;
afterEach(() => rig?.cleanup());

function ran(rec: { pid: string }): boolean { return fs.existsSync(rec.pid); }
function argvOf(rec: { argv: string }): string[] { return fs.readFileSync(rec.argv, 'utf8').trimEnd().split('\n'); }

describe('relay gate: switch off', () => {
  it('runs the Node server, never runs the shim, prints nothing about the relay', async () => {
    rig = makeRig();
    const rec = rig.recorder();
    const r = await runServer(['--port', PORT], rig.env({ SUPERSURF_SHIM_BIN: rec.bin }));
    expect(r.initReply?.result?.serverInfo?.name).toBe('SuperSurf');
    expect(ran(rec)).toBe(false);
    expect(r.stderr).not.toMatch(/relay|supersurf-shim/i);
    expect(fs.existsSync(path.join(rig.home, '.supersurf', 'daemon', 'entry'))).toBe(false);
  });
});

describe('relay gate: switch on with a binary', () => {
  const cases: [string, string[], Record<string, string>, (rig: Rig) => void][] = [
    ['SUPERSURF_RELAY=1', ['--port', PORT], { SUPERSURF_RELAY: '1' }, () => {}],
    ['--relay flag', ['--relay', '--port', PORT], {}, () => {}],
    ['agents.relay in the config file', ['--port', PORT], {}, (r) => fs.writeFileSync(r.config, JSON.stringify({ agents: { relay: true } }))],
  ];
  for (const [name, args, env, setup] of cases) {
    it(`${name}: the shim runs with --port first and its exit code is the process exit code`, async () => {
      rig = makeRig();
      setup(rig);
      const rec = rig.recorder(7);
      const r = await runServer(args, rig.env({ SUPERSURF_SHIM_BIN: rec.bin, ...env }));
      expect(r.code).toBe(7);
      expect(argvOf(rec).slice(0, 2)).toEqual(['--port', PORT]);
      expect(r.initReply).toBeNull();
      expect(r.stderr).toBe('');
    });
  }

  it.skipIf(!hasExecve)('execve: the shim runs under the server process pid', async () => {
    rig = makeRig();
    const rec = rig.recorder(0);
    const r = await runServer(['--relay', '--port', PORT], rig.env({ SUPERSURF_SHIM_BIN: rec.bin }));
    expect(Number(fs.readFileSync(rec.pid, 'utf8'))).toBe(r.pid);
  });

  it('passes only the shim flags, after dropping the legacy `mcp` positional', async () => {
    rig = makeRig();
    const rec = rig.recorder();
    await runServer(['mcp', '--relay', '--port', PORT, '--multi-agent', '--debug', 'no_truncate', '--log-file', '/x.log', '--disable-secure-eval'],
      rig.env({ SUPERSURF_SHIM_BIN: rec.bin }));
    expect(argvOf(rec)).toEqual(['--port', PORT, '--multi-agent', '--debug', '--disable-secure-eval']);
  });

  it('uses the default port when none is given', async () => {
    rig = makeRig();
    const rec = rig.recorder();
    await runServer([], rig.env({ SUPERSURF_SHIM_BIN: rec.bin, SUPERSURF_RELAY: '1' }));
    expect(argvOf(rec)).toEqual(['--port', '5555']);
  });

  it('does not relay in --script-mode', async () => {
    rig = makeRig();
    const rec = rig.recorder();
    const r = await runServer(['--script-mode', '--relay'], rig.env({ SUPERSURF_SHIM_BIN: rec.bin, SUPERSURF_RELAY: '1' }));
    expect(ran(rec)).toBe(false);
    expect(fs.existsSync(rec.argv)).toBe(false);
    expect(r.initReply?.id).toBe(1); // script mode answered the JSON-RPC line itself
  });

  it('does not relay in the hot-reload child (--child)', async () => {
    rig = makeRig();
    const rec = rig.recorder();
    await runServer(['--child', '--relay'], rig.env({ SUPERSURF_SHIM_BIN: rec.bin }));
    expect(ran(rec)).toBe(false);
  });
});

describe('relay gate: switch on, binary missing', () => {
  // A binary built with `npm run build.shim` at <daemon>/bin is found by design, so this case cannot run then.
  it.skipIf(fs.existsSync(BUILT_SHIM))('warns once on stderr and runs the Node server', async () => {
    rig = makeRig();
    const r = await runServer(['--relay', '--port', PORT], rig.env({ SUPERSURF_SHIM_BIN: path.join(rig.home, 'absent') }));
    expect(r.initReply?.result?.serverInfo?.name).toBe('SuperSurf');
    const lines = r.stderr.split('\n').filter((l) => /agents\.relay/.test(l));
    expect(lines).toEqual(['[supersurf] agents.relay is on but supersurf-shim was not found (set SUPERSURF_SHIM_BIN, or install a SuperSurf build that ships it); running the Node server.']);
  });
});

describe('relay gate: the binary does not run', () => {
  it('warns once naming the error and runs the Node server', async () => {
    rig = makeRig();
    // Executable but not a program: process.execve would abort the process, so the probe must catch it first.
    const bin = path.join(rig.home, 'bad-shim');
    fs.writeFileSync(bin, 'not a program\n', { mode: 0o755 });
    const r = await runServer(['--relay', '--port', PORT], rig.env({ SUPERSURF_SHIM_BIN: bin }));
    expect(r.initReply?.result?.serverInfo?.name).toBe('SuperSurf');
    const lines = r.stderr.split('\n').filter((l) => /supersurf-shim/.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[supersurf\] could not hand over to supersurf-shim: .+; running the Node server\.$/);
  });
});
