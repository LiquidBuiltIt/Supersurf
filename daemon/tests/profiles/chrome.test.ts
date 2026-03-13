import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  appendPidLog,
  replayPidLog,
  findOrphanPids,
  truncatePidLog,
} from '../../src/profiles/chrome';

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

describe('findChromiumBinary', () => {
  it('is importable', async () => {
    const { findChromiumBinary } = await import('../../src/profiles/chrome');
    expect(typeof findChromiumBinary).toBe('function');
    // Result depends on the environment — may return path or null
    const result = findChromiumBinary();
    expect(result === null || typeof result === 'string').toBe(true);
  });
});
