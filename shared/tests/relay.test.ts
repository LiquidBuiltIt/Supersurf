import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findShimBinary, shimArgs, execReplace, readRelaySwitch, probeShim } from '../relay';

let dir: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ['SUPERSURF_SHIM_BIN', 'SUPERSURF_CONFIG_FILE', 'SUPERSURF_RELAY', 'SUPERSURF_PORT'];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(dir, { recursive: true, force: true });
});

function script(name: string, body = 'exit 0', mode = 0o755): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode });
  fs.chmodSync(p, mode);
  return p;
}

describe('findShimBinary', () => {
  it('returns null with no env and no root', () => {
    expect(findShimBinary()).toBeNull();
  });

  it('prefers an absolute SUPERSURF_SHIM_BIN over <root>/bin/supersurf-shim', () => {
    const env = script('env-shim');
    fs.mkdirSync(path.join(dir, 'pkg', 'bin'), { recursive: true });
    fs.copyFileSync(env, path.join(dir, 'pkg', 'bin', 'supersurf-shim'));
    fs.chmodSync(path.join(dir, 'pkg', 'bin', 'supersurf-shim'), 0o755);
    process.env.SUPERSURF_SHIM_BIN = env;
    expect(findShimBinary(path.join(dir, 'pkg'))).toBe(env);
  });

  it('falls back to <root>/bin/supersurf-shim', () => {
    fs.mkdirSync(path.join(dir, 'bin'));
    const bin = path.join(dir, 'bin', 'supersurf-shim');
    fs.writeFileSync(bin, '', { mode: 0o755 });
    expect(findShimBinary(dir)).toBe(bin);
  });

  it('ignores a relative SUPERSURF_SHIM_BIN', () => {
    script('rel');
    process.env.SUPERSURF_SHIM_BIN = 'rel';
    expect(findShimBinary()).toBeNull();
  });

  it('skips a file that is not executable', () => {
    process.env.SUPERSURF_SHIM_BIN = script('noexec', 'exit 0', 0o644);
    expect(findShimBinary()).toBeNull();
  });

  it('skips a directory', () => {
    fs.mkdirSync(path.join(dir, 'd'));
    process.env.SUPERSURF_SHIM_BIN = path.join(dir, 'd');
    expect(findShimBinary()).toBeNull();
  });

  it('falls through a non-executable env file to an executable <root> file', () => {
    process.env.SUPERSURF_SHIM_BIN = script('noexec', 'exit 0', 0o644);
    fs.mkdirSync(path.join(dir, 'bin'));
    const bin = path.join(dir, 'bin', 'supersurf-shim');
    fs.writeFileSync(bin, '', { mode: 0o755 });
    expect(findShimBinary(dir)).toBe(bin);
  });
});

describe('shimArgs', () => {
  const cases: [string, string[], string[]][] = [
    ['empty argv gives only the port', [], ['--port', '5555']],
    ['drops --port N and --port=N, emits the resolved port', ['--port', '1234', '--port=99'], ['--port', '5555']],
    ['bare --debug', ['--debug'], ['--port', '5555', '--debug']],
    ['--debug=no_truncate', ['--debug=no_truncate'], ['--port', '5555', '--debug']],
    ['--debug <mode> skips the mode token', ['--debug', 'no_truncate', '--multi-agent'], ['--port', '5555', '--debug', '--multi-agent']],
    ['--debug followed by a flag keeps the flag', ['--debug', '--multi-agent'], ['--port', '5555', '--debug', '--multi-agent']],
    ['security flags pass through in the order given', ['--disable-playbook-eval', '--disable-secure-eval'], ['--port', '5555', '--disable-playbook-eval', '--disable-secure-eval']],
    ['drops --relay, --child, --log-file <p> and positionals', ['--relay', '--child', '--log-file', '/x/y.log', 'stray'], ['--port', '5555']],
  ];
  for (const [name, argv, want] of cases) {
    it(name, () => expect(shimArgs(argv, 5555)).toEqual(want));
  }
});

describe('probeShim', () => {
  // process.execve ABORTS the process when the exec fails (ENOEXEC, wrong architecture): there is no
  // throw to catch, so the binary is proven runnable first.
  it('passes when `<bin> --version` exits 0', () => {
    expect(() => probeShim(script('ok', 'exit 0'))).not.toThrow();
  });

  it('throws when the binary exits non-zero', () => {
    expect(() => probeShim(script('bad', 'exit 3'))).toThrow(/exited 3/);
  });

  it('throws when the file cannot be executed (no shebang, not a binary)', () => {
    const p = path.join(dir, 'junk');
    fs.writeFileSync(p, 'not a program\n', { mode: 0o755 });
    expect(() => probeShim(p)).toThrow(/ENOEXEC|exited 127/);
  });

  it('throws when it hangs past the timeout', () => {
    expect(() => probeShim(script('slow', 'sleep 5'), 200)).toThrow(/ETIMEDOUT|timed out/);
  });
});

describe('execReplace', () => {
  it('calls execve(file, [file, ...args], process.env) when it exists', async () => {
    const calls: any[] = [];
    const execve = ((...a: any[]) => { calls.push(a); throw new Error('stop'); }) as any;
    await expect(execReplace('/bin/x', ['--port', '1'], { execve })).rejects.toThrow('stop');
    expect(calls).toEqual([['/bin/x', ['/bin/x', '--port', '1'], process.env]]);
  });

  it('rejects when execve throws (the caller falls back)', async () => {
    const execve = (() => { throw new Error('ENOEXEC'); }) as any;
    await expect(execReplace('/bin/x', [], { execve })).rejects.toThrow('ENOEXEC');
  });

  it('spawns with inherited stdio when execve is absent and resolves the exit code', async () => {
    const out = path.join(dir, 'argv');
    const sh = script('rec', `printf '%s\\n' "$@" > "${out}"; exit 7`);
    expect(await execReplace(sh, ['a', 'b'], { execve: undefined })).toBe(7);
    expect(fs.readFileSync(out, 'utf8')).toBe('a\nb\n');
  });

  it('resolves 128 + signum on a signal death', async () => {
    const sh = script('sig', 'kill -TERM $$');
    expect(await execReplace(sh, [], { execve: undefined })).toBe(128 + 15);
  });

  it('rejects when the spawn itself fails', async () => {
    await expect(execReplace(path.join(dir, 'missing'), [], { execve: undefined })).rejects.toThrow();
  });

  it('forwards SIGTERM to the child and removes its handlers afterwards', async () => {
    const sh = script('wait', 'trap "exit 9" TERM; while :; do sleep 0.05; done');
    const before = process.listenerCount('SIGTERM');
    const p = execReplace(sh, [], { execve: undefined });
    await new Promise((r) => setTimeout(r, 300));
    process.emit('SIGTERM' as any);
    expect(await p).toBe(9);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});

describe('readRelaySwitch', () => {
  it('is off with no config, no env, no flag', () => {
    process.env.SUPERSURF_CONFIG_FILE = path.join(dir, 'none.json');
    expect(readRelaySwitch([])).toEqual({ relay: false, port: 5555 });
  });

  it('reads --relay and --port N from argv', () => {
    process.env.SUPERSURF_CONFIG_FILE = path.join(dir, 'none.json');
    expect(readRelaySwitch(['--relay', '--port', '6001'])).toEqual({ relay: true, port: 6001 });
    expect(readRelaySwitch(['--port=6002'])).toEqual({ relay: false, port: 6002 });
  });

  it('reads SUPERSURF_RELAY from the env', () => {
    process.env.SUPERSURF_CONFIG_FILE = path.join(dir, 'none.json');
    process.env.SUPERSURF_RELAY = '1';
    expect(readRelaySwitch([]).relay).toBe(true);
  });

  it('reads agents.relay and daemon.port from SUPERSURF_CONFIG_FILE', () => {
    const f = path.join(dir, 'c.json');
    fs.writeFileSync(f, JSON.stringify({ agents: { relay: true }, daemon: { port: 6100 } }));
    process.env.SUPERSURF_CONFIG_FILE = f;
    expect(readRelaySwitch([])).toEqual({ relay: true, port: 6100 });
  });

  it('a flag beats the file; a malformed file is silent and means off', () => {
    const f = path.join(dir, 'c.json');
    fs.writeFileSync(f, JSON.stringify({ daemon: { port: 6100 } }));
    process.env.SUPERSURF_CONFIG_FILE = f;
    expect(readRelaySwitch(['--port', '6200']).port).toBe(6200);
    fs.writeFileSync(f, '{nope');
    expect(readRelaySwitch([])).toEqual({ relay: false, port: 5555 });
  });

  it('creates no config file', () => {
    const f = path.join(dir, 'new.json');
    process.env.SUPERSURF_CONFIG_FILE = f;
    readRelaySwitch([]);
    expect(fs.existsSync(f)).toBe(false);
  });
});
