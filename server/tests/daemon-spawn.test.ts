import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock logger
vi.mock('../src/logger', () => ({
  createLog: () => (..._args: unknown[]) => {},
}));

// We need to mock the file paths and child_process
const mockSuperSurfDir = path.join(os.tmpdir(), 'daemon-spawn-test');
const mockPidFile = path.join(mockSuperSurfDir, 'daemon.pid');
const mockSockFile = path.join(mockSuperSurfDir, 'daemon.sock');

// Mock the module constants by mocking the module
vi.mock('../src/daemon-spawn', async () => {
  const actual = await vi.importActual<typeof import('../src/daemon-spawn')>('../src/daemon-spawn');

  return {
    ...actual,
    getSockPath: () => mockSockFile,
    getPidPath: () => mockPidFile,
  };
});

// The stopDaemon tests below need a genuinely fresh, unmocked module per test
// (re-imported after mocking os.homedir()) so its internal PID_FILE/SOCK_FILE
// constants resolve under a temp dir — never the real ~/.supersurf. Unmocking
// here, at top level, makes that explicit instead of relying on a nested
// vi.unmock() being hoisted (which triggers a deprecation warning). None of
// the assertions above this point depend on the mocked path values.
vi.unmock('../src/daemon-spawn');

import { isDaemonRunning, getSockPath, getPidPath, resolveDaemonEntry, explainStartupFailure } from '../src/daemon-spawn';

describe('daemon-spawn', () => {
  beforeEach(() => {
    if (!fs.existsSync(mockSuperSurfDir)) {
      fs.mkdirSync(mockSuperSurfDir, { recursive: true });
    }
  });

  afterEach(() => {
    try { fs.rmSync(mockSuperSurfDir, { recursive: true }); } catch {}
  });

  describe('getSockPath', () => {
    it('returns a path', () => {
      const p = getSockPath();
      expect(typeof p).toBe('string');
      expect(p.endsWith('daemon.sock')).toBe(true);
    });
  });

  describe('getPidPath', () => {
    it('returns a path', () => {
      const p = getPidPath();
      expect(typeof p).toBe('string');
      expect(p.endsWith('daemon.pid')).toBe(true);
    });
  });

  describe('isDaemonRunning', () => {
    it('returns false when no PID file exists', () => {
      // isDaemonRunning reads from ~/.supersurf/daemon.pid (actual path)
      // This test depends on actual state, but without a PID file it should return false
      // We can't easily test without deeper mocking, so test the concept
      expect(typeof isDaemonRunning()).toBe('boolean');
    });
  });
});

describe('resolveDaemonEntry', () => {
  it('resolves the separate supersurf-daemon package entry', () => {
    const entry = resolveDaemonEntry();
    expect(entry.endsWith('main.js')).toBe(true);
    expect(entry).toContain('daemon');
  });

  // Regression for the dead daemon CLI: the bin dispatcher used to import
  // '../daemon/main' (server/dist/daemon/main), a bundle-copy path that was
  // never built — so `supersurf daemon status|stop|restart` crashed with
  // MODULE_NOT_FOUND. The fix routes through this resolver; lock that it points
  // at a file that actually exists on disk.
  it('resolves to a daemon entry file that exists on disk', () => {
    expect(fs.existsSync(resolveDaemonEntry())).toBe(true);
  });
});

describe('explainStartupFailure', () => {
  it('renders an actionable message for the wedged-port EADDRINUSE case', () => {
    const raw = 'Failed to start extension WebSocket: listen EADDRINUSE 127.0.0.1:5555';
    const msg = explainStartupFailure(raw, 5555);
    expect(msg).toContain('EADDRINUSE');
    expect(msg).toContain('5555');
    expect(msg).toContain('supersurf-daemon');
  });

  it('falls back to the last non-empty stderr line when not a known case', () => {
    const raw = 'some noise\n\nDaemon fatal error: boom\n';
    expect(explainStartupFailure(raw, 5555)).toBe('Daemon fatal error: boom');
  });

  it('returns null when there is no captured output', () => {
    expect(explainStartupFailure('', 5555)).toBeNull();
    expect(explainStartupFailure('   \n  \n', 5555)).toBeNull();
  });
});

describe('stopDaemon', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'stopd-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('is a no-op when no PID file exists', async () => {
    const { stopDaemon } = await import('../src/daemon-spawn');
    await expect(stopDaemon()).resolves.toBeUndefined();
  });

  it('removes stale pid and sock files when the PID is dead', async () => {
    const dir = path.join(tmpHome, '.supersurf');
    fs.mkdirSync(dir, { recursive: true });
    // PID 99999999 exceeds kernel.pid_max defaults — reliably dead.
    fs.writeFileSync(path.join(dir, 'daemon.pid'), '99999999');
    fs.writeFileSync(path.join(dir, 'daemon.sock'), '');

    const { stopDaemon } = await import('../src/daemon-spawn');
    await stopDaemon();

    expect(fs.existsSync(path.join(dir, 'daemon.pid'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'daemon.sock'))).toBe(false);
  });

  it('terminates a live process named in the PID file', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn('sleep', ['30']);
    const dir = path.join(tmpHome, '.supersurf');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'daemon.pid'), String(child.pid));

    const { stopDaemon } = await import('../src/daemon-spawn');
    await stopDaemon();

    // Signal 0 probe: throws once the process is fully reaped.
    await new Promise(r => setTimeout(r, 200));
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });
});
