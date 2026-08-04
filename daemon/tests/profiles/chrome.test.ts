import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  appendPidLog,
  replayPidLog,
  findOrphanPids,
  truncatePidLog,
  isSnapBinary,
  isSnapOnlySystem,
  findChromiumBinary,
  spawnChromium,
} from '../../src/profiles/chrome';
import type { PidLogEntry } from '../../src/profiles/types';

const spawnMock = vi.fn(() => ({ pid: 12345, unref: vi.fn(), on: vi.fn() }));
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args as Parameters<typeof spawnMock>) };
});

describe('Chrome PID log', () => {
  let tmpDir: string;
  let originalPidLogFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supersurf-test-chrome-'));
    // We need to test the PID log functions — they use a hardcoded path
    // so we'll test the pure logic functions directly
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('findOrphanPids', () => {
    it('finds spawned but not killed PIDs', () => {
      const entries = [
        { action: 'spawn' as const, profile: 'a', pid: 100, ts: '2026-01-01T00:00:00Z' },
        { action: 'spawn' as const, profile: 'b', pid: 200, ts: '2026-01-01T00:00:01Z' },
        { action: 'kill' as const, profile: 'a', pid: 100, ts: '2026-01-01T00:00:02Z' },
      ];
      expect(findOrphanPids(entries)).toEqual([200]);
    });

    it('returns empty when all are killed', () => {
      const entries = [
        { action: 'spawn' as const, profile: 'a', pid: 100, ts: '2026-01-01T00:00:00Z' },
        { action: 'kill' as const, profile: 'a', pid: 100, ts: '2026-01-01T00:00:01Z' },
      ];
      expect(findOrphanPids(entries)).toEqual([]);
    });

    it('handles empty log', () => {
      expect(findOrphanPids([])).toEqual([]);
    });

    it('handles multiple spawns of the same PID', () => {
      const entries = [
        { action: 'spawn' as const, profile: 'a', pid: 100, ts: '2026-01-01T00:00:00Z' },
        { action: 'kill' as const, profile: 'a', pid: 100, ts: '2026-01-01T00:00:01Z' },
        { action: 'spawn' as const, profile: 'a', pid: 100, ts: '2026-01-01T00:00:02Z' },
      ];
      expect(findOrphanPids(entries)).toEqual([100]);
    });
  });
});

describe('findOrphanPids owner filtering', () => {
  it('excludes user-owned spawns from orphan detection', () => {
    const entries: PidLogEntry[] = [
      { action: 'spawn', profile: 'a', pid: 101, ts: '2026-06-28T00:00:00Z' },
      { action: 'spawn', profile: 'b', pid: 102, owner: 'user', ts: '2026-06-28T00:00:01Z' },
      { action: 'spawn', profile: 'c', pid: 103, owner: 'daemon', ts: '2026-06-28T00:00:02Z' },
    ];
    expect(findOrphanPids(entries)).toEqual([101, 103]);
  });

  it('still removes killed pids regardless of owner', () => {
    const entries: PidLogEntry[] = [
      { action: 'spawn', profile: 'a', pid: 201, owner: 'daemon', ts: '2026-06-28T00:00:00Z' },
      { action: 'kill', profile: 'a', pid: 201, ts: '2026-06-28T00:00:01Z' },
    ];
    expect(findOrphanPids(entries)).toEqual([]);
  });
});

describe('findChromiumBinary', () => {
  it('is importable', async () => {
    expect(typeof findChromiumBinary).toBe('function');
    // Result depends on the environment — may return path or null
    const result = findChromiumBinary();
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('does not return a Snap-confined binary even if one exists on PATH', () => {
    // realpath any candidate to a /snap/ path → findChromiumBinary must return null
    const spy = vi.spyOn(fs, 'realpathSync').mockReturnValue('/snap/chromium/3107/usr/lib/chromium-browser/chrome' as any);
    try {
      expect(findChromiumBinary()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('isSnapBinary', () => {
  let realpathSpy: ReturnType<typeof vi.spyOn> | null = null;

  afterEach(() => {
    if (realpathSpy) {
      realpathSpy.mockRestore();
      realpathSpy = null;
    }
  });

  it('returns true when the binary resolves under /snap/', () => {
    realpathSpy = vi.spyOn(fs, 'realpathSync').mockReturnValue(
      '/snap/chromium/3107/usr/lib/chromium-browser/chrome' as any,
    );
    expect(isSnapBinary('/usr/bin/chromium')).toBe(true);
  });

  it('returns false for a deb-installed binary', () => {
    realpathSpy = vi.spyOn(fs, 'realpathSync').mockReturnValue(
      '/usr/lib/chromium/chromium' as any,
    );
    expect(isSnapBinary('/usr/bin/chromium')).toBe(false);
  });

  it('returns false for google-chrome-stable resolving under /opt/google/', () => {
    realpathSpy = vi.spyOn(fs, 'realpathSync').mockReturnValue(
      '/opt/google/chrome/google-chrome' as any,
    );
    expect(isSnapBinary('/usr/bin/google-chrome-stable')).toBe(false);
  });

  it('returns false when realpathSync throws (e.g. dangling symlink)', () => {
    realpathSpy = vi.spyOn(fs, 'realpathSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(isSnapBinary('/nonexistent')).toBe(false);
  });
});

describe('isSnapOnlySystem', () => {
  it('is importable and returns a boolean', () => {
    expect(typeof isSnapOnlySystem).toBe('function');
    expect(typeof isSnapOnlySystem()).toBe('boolean');
  });

  it('returns true when every Chromium candidate resolves under /snap/', () => {
    // Force at least one candidate to exist on PATH so we exercise the "all snap" branch
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const realpathSpy = vi.spyOn(fs, 'realpathSync').mockReturnValue(
      '/snap/chromium/3107/usr/lib/chromium-browser/chrome' as any,
    );
    try {
      expect(isSnapOnlySystem()).toBe(true);
    } finally {
      existsSpy.mockRestore();
      realpathSpy.mockRestore();
    }
  });

  it('returns false when at least one candidate is non-Snap', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const realpathSpy = vi.spyOn(fs, 'realpathSync').mockReturnValue(
      '/usr/lib/chromium/chromium' as any,
    );
    try {
      expect(isSnapOnlySystem()).toBe(false);
    } finally {
      existsSpy.mockRestore();
      realpathSpy.mockRestore();
    }
  });
});

describe('spawnChromium extension dir validation', () => {
  it('throws a diagnostic error when extension dir is missing manifest.json', () => {
    // Make findChromiumBinary return a non-Snap path
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p: any) => {
      // The chromium binary lookup checks paths under /opt or /usr — return true
      // for the first such candidate so findChromiumBinary returns a binary.
      if (String(p).endsWith('manifest.json')) return false;
      return true;
    });
    const realpathSpy = vi.spyOn(fs, 'realpathSync').mockReturnValue(
      '/usr/lib/chromium/chromium' as any,
    );

    try {
      expect(() => spawnChromium('test-profile', '/nonexistent/extension', 5555, false))
        .toThrow(/Extension not found.*manifest\.json/);
      expect(() => spawnChromium('test-profile', '/nonexistent/extension', 5555, false))
        .toThrow(/supersurf-daemon restart/);
    } finally {
      existsSpy.mockRestore();
      realpathSpy.mockRestore();
    }
  });
});

describe('spawnChromium registration URL', () => {
  let existsSpy: ReturnType<typeof vi.spyOn>;
  let realpathSpy: ReturnType<typeof vi.spyOn>;
  let mkdirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spawnMock.mockClear();
    existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    realpathSpy = vi.spyOn(fs, 'realpathSync').mockReturnValue('/usr/lib/chromium/chromium' as any);
    mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined as any);
  });

  afterEach(() => {
    existsSpy.mockRestore();
    realpathSpy.mockRestore();
    mkdirSpy.mockRestore();
  });

  it('appends the registration URL when openRegistration is true', () => {
    spawnChromium('job-search', '/ext', 5555, true);
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('http://127.0.0.1:5555/register/job-search');
  });

  it('omits the registration URL when openRegistration is false', () => {
    spawnChromium('job-search', '/ext', 5555, false);
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).not.toContain('http://127.0.0.1:5555/register/job-search');
  });
});

describe('spawnChromium startupOpts', () => {
  let existsSpy: ReturnType<typeof vi.spyOn>;
  let realpathSpy: ReturnType<typeof vi.spyOn>;
  let mkdirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spawnMock.mockClear();
    existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    realpathSpy = vi.spyOn(fs, 'realpathSync').mockReturnValue('/usr/lib/chromium/chromium' as any);
    mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined as any);
  });

  afterEach(() => {
    existsSpy.mockRestore();
    realpathSpy.mockRestore();
    mkdirSpy.mockRestore();
  });

  it('omits --disable-gpu by default', () => {
    spawnChromium('p', '/ext', 5555, false);
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).not.toContain('--disable-gpu');
  });

  it('appends --disable-gpu when disableGpu is true', () => {
    spawnChromium('p', '/ext', 5555, false, { disableGpu: true });
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('--disable-gpu');
  });

  it('omits --disable-gpu when disableGpu is false', () => {
    spawnChromium('p', '/ext', 5555, false, { disableGpu: false });
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).not.toContain('--disable-gpu');
  });

  it('uses startupOpts.chromePath as the spawn binary when set', () => {
    const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    spawnChromium('p', '/ext', 5555, false, { chromePath });
    expect(spawnMock.mock.calls[0][0]).toBe(chromePath);
  });

  it('throws when chromePath is set but the binary does not exist', () => {
    existsSpy.mockImplementation((p: any) => {
      if (String(p).includes('Google Chrome')) return false;
      return true;
    });
    expect(() =>
      spawnChromium('p', '/ext', 5555, false, {
        chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      }),
    ).toThrow(/chrome_path|Chrome binary not found/i);
  });
});
