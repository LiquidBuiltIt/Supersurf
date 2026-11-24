import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * `supersurf mcp` and the `agents.relay` switch. `execReplace` is mocked: the real one would
 * `process.execve` over the test runner. `node:child_process` is mocked as in dispatcher.test.ts, so
 * the fall-through shell-out is observable without running npx.
 */
const spawned: { cmd: string; args: string[] }[] = [];
const execReplaceMock = vi.fn();

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[]) => {
      spawned.push({ cmd, args });
      const listeners = new Map<string, (...a: any[]) => void>();
      setImmediate(() => listeners.get('exit')?.(0, null));
      return { on: vi.fn((e: string, cb: (...a: any[]) => void) => { listeners.set(e, cb); }), kill: vi.fn() } as any;
    }),
  };
});
vi.mock('shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('shared')>()),
  execReplace: (...a: unknown[]) => execReplaceMock(...a),
}));

import { dispatch } from '../src/dispatcher';
import { relayMcp } from '../src/relay';
import { VERSION } from '../src/version';

const KEYS = ['SUPERSURF_SHIM_BIN', 'SUPERSURF_CONFIG_FILE', 'SUPERSURF_RELAY', 'SUPERSURF_PORT', 'SUPERSURF_DEV_ENVIRONMENT'];
const saved: Record<string, string | undefined> = {};
let home: string;
let recBin: string;
let recPid: string;
let err: ReturnType<typeof vi.spyOn>;
let exitCode: number | undefined;
const savedArgv = process.argv;

beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'clr-'));
  process.env.SUPERSURF_CONFIG_FILE = path.join(home, 'config.json');
  recBin = path.join(home, 'rec-shim');
  recPid = path.join(home, 'rec.pid');
  // `--version` (the probe) exits 0; anything else would record, and must never happen here.
  fs.writeFileSync(recBin, `#!/bin/sh\n[ "$1" = "--version" ] && exit 0\necho $$ > "${recPid}"\nexit 7\n`, { mode: 0o755 });
  spawned.length = 0;
  execReplaceMock.mockReset();
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitCode = undefined;
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { exitCode = c; return undefined as never; }) as any);
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.restoreAllMocks();
  process.argv = savedArgv;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('relayMcp', () => {
  it('off: null, nothing executed, no output', async () => {
    process.env.SUPERSURF_SHIM_BIN = recBin;
    expect(await relayMcp(['--port', '6001'])).toBeNull();
    expect(execReplaceMock).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it('on with --script-mode: null, nothing executed', async () => {
    process.env.SUPERSURF_SHIM_BIN = recBin;
    process.env.SUPERSURF_RELAY = '1';
    expect(await relayMcp(['--script-mode'])).toBeNull();
    expect(execReplaceMock).not.toHaveBeenCalled();
  });

  it('on with a binary: execs it with the shim args and the resolved port, returns its code', async () => {
    process.env.SUPERSURF_SHIM_BIN = recBin;
    execReplaceMock.mockResolvedValue(7);
    expect(await relayMcp(['--relay', '--port=6002', '--multi-agent', '--log-file', 'x'])).toBe(7);
    expect(execReplaceMock).toHaveBeenCalledWith(recBin, ['--port', '6002', '--multi-agent']);
    expect(err).not.toHaveBeenCalled();
  });

  it('on, no binary: null and no warning (the server warns once)', async () => {
    process.env.SUPERSURF_RELAY = '1';
    process.env.SUPERSURF_SHIM_BIN = path.join(home, 'absent');
    expect(await relayMcp([])).toBeNull();
    expect(execReplaceMock).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it('on, port outside 1..65535: null, nothing executed, no warning (the server warns once)', async () => {
    process.env.SUPERSURF_SHIM_BIN = recBin;
    expect(await relayMcp(['--relay', '--port', '70000'])).toBeNull();
    expect(execReplaceMock).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it('on, binary from SUPERSURF_DEV_ENVIRONMENT when nothing else names one', async () => {
    const root = path.join(home, 'clone');
    const target = `${process.platform}-${({ x64: 'amd64', arm64: 'arm64' } as Record<string, string>)[process.arch]}`;
    fs.mkdirSync(path.join(root, 'server', 'bin', target), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'supersurf' }));
    const bin = path.join(root, 'server', 'bin', target, 'supersurf-shim');
    fs.copyFileSync(recBin, bin);
    fs.chmodSync(bin, 0o755);
    process.env.SUPERSURF_DEV_ENVIRONMENT = root;
    execReplaceMock.mockResolvedValue(0);
    expect(await relayMcp(['--relay'])).toBe(0);
    expect(execReplaceMock.mock.calls[0][0]).toBe(bin);
  });

  it('on: a rejected exec warns once and returns null', async () => {
    process.env.SUPERSURF_SHIM_BIN = recBin;
    process.env.SUPERSURF_RELAY = '1';
    execReplaceMock.mockRejectedValue(new Error('boom'));
    expect(await relayMcp([])).toBeNull();
    expect(err.mock.calls).toEqual([['[supersurf] could not hand over to supersurf-shim: boom; running the Node server.']]);
  });

  it('on: a binary that fails its --version probe never reaches exec', async () => {
    const bad = path.join(home, 'bad');
    fs.writeFileSync(bad, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    process.env.SUPERSURF_SHIM_BIN = bad;
    process.env.SUPERSURF_RELAY = '1';
    expect(await relayMcp([])).toBeNull();
    expect(execReplaceMock).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(1);
  });
});

describe('dispatch mcp with the relay switch', () => {
  it('off: shells out to the pinned npx package; the recording shim never runs', async () => {
    process.env.SUPERSURF_SHIM_BIN = recBin;
    await dispatch(['node', 'supersurf', 'mcp', '--port', '6001']);
    expect(spawned[0].cmd).toBe('npx');
    expect(spawned[0].args).toEqual(['--yes', `supersurf-mcp@${VERSION}`, '--port', '6001']);
    expect(execReplaceMock).not.toHaveBeenCalled();
    expect(fs.existsSync(recPid)).toBe(false);
  });

  it('on with a binary: exec path with shimArgs, exits with its code, no shell-out', async () => {
    process.env.SUPERSURF_SHIM_BIN = recBin;
    process.env.SUPERSURF_RELAY = '1';
    execReplaceMock.mockResolvedValue(5);
    await dispatch(['node', 'supersurf', 'mcp', '--debug', 'no_truncate', '--port', '6003', '--disable-secure-eval']);
    expect(execReplaceMock).toHaveBeenCalledWith(recBin, ['--port', '6003', '--debug', '--disable-secure-eval']);
    expect(exitCode).toBe(5);
    expect(spawned).toEqual([]);
  });

  it('on, no binary: shell-out as before, no warning', async () => {
    process.env.SUPERSURF_RELAY = '1';
    process.env.SUPERSURF_SHIM_BIN = path.join(home, 'absent');
    await dispatch(['node', 'supersurf', 'mcp']);
    expect(spawned[0].args).toEqual(['--yes', `supersurf-mcp@${VERSION}`]);
    expect(err).not.toHaveBeenCalled();
  });

  it('on with --script-mode: shell-out, the shim is not used', async () => {
    process.env.SUPERSURF_SHIM_BIN = recBin;
    process.env.SUPERSURF_RELAY = '1';
    await dispatch(['node', 'supersurf', 'mcp', '--script-mode']);
    expect(spawned[0].args).toEqual(['--yes', `supersurf-mcp@${VERSION}`, '--script-mode']);
    expect(execReplaceMock).not.toHaveBeenCalled();
  });

  it('on, exec rejects: one warning, then the shell-out', async () => {
    process.env.SUPERSURF_SHIM_BIN = recBin;
    process.env.SUPERSURF_RELAY = '1';
    execReplaceMock.mockRejectedValue(new Error('boom'));
    await dispatch(['node', 'supersurf', 'mcp']);
    expect(err).toHaveBeenCalledTimes(1);
    expect(spawned[0].cmd).toBe('npx');
  });
});
