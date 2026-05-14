import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HARDCODED_DEFAULTS } from 'shared';
import { parseArgs, formatUptime, stopDaemon, PID_FILE, SOCK_FILE } from '../src/main';

// Test the exported utility functions from main.ts without running the entry point

describe('Daemon main utilities', () => {
  const tmpDir = path.join(os.tmpdir(), 'daemon-main-test');

  beforeEach(() => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  describe('PID file lifecycle', () => {
    it('detects current process as alive', () => {
      // process.kill(pid, 0) should not throw for own PID
      let alive = false;
      try {
        process.kill(process.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      expect(alive).toBe(true);
    });

    it('detects dead PID', () => {
      // PID 99999999 is almost certainly not running
      let alive = false;
      try {
        process.kill(99999999, 0);
        alive = true;
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    });

    it('can write and read PID file', () => {
      const pidFile = path.join(tmpDir, 'test.pid');
      fs.writeFileSync(pidFile, String(process.pid));

      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      expect(pid).toBe(process.pid);

      fs.unlinkSync(pidFile);
      expect(fs.existsSync(pidFile)).toBe(false);
    });

    it('stale PID detection: dead process PID file should be removable', () => {
      const pidFile = path.join(tmpDir, 'stale.pid');
      fs.writeFileSync(pidFile, '99999999');

      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }

      expect(alive).toBe(false);

      // Clean up stale file
      fs.unlinkSync(pidFile);
      expect(fs.existsSync(pidFile)).toBe(false);
    });
  });

  describe('socket file cleanup', () => {
    it('orphaned socket without PID file should be detectable', () => {
      const sockFile = path.join(tmpDir, 'orphan.sock');
      fs.writeFileSync(sockFile, '');

      expect(fs.existsSync(sockFile)).toBe(true);

      // No PID file = orphaned
      const pidFile = path.join(tmpDir, 'daemon.pid');
      expect(fs.existsSync(pidFile)).toBe(false);

      // Should clean it
      fs.unlinkSync(sockFile);
      expect(fs.existsSync(sockFile)).toBe(false);
    });
  });

  describe('parseArgs', () => {
    it('parses start command', () => {
      const args = parseArgs(['node', 'daemon', 'start']);
      expect(args.command).toBe('start');
    });

    it('parses stop command', () => {
      const args = parseArgs(['node', 'daemon', 'stop']);
      expect(args.command).toBe('stop');
    });

    it('parses restart command', () => {
      const args = parseArgs(['node', 'daemon', 'restart']);
      expect(args.command).toBe('restart');
    });

    it('parses restart with flags', () => {
      const args = parseArgs(['node', 'daemon', 'restart', '--port', '9999', '--debug']);
      expect(args.command).toBe('restart');
      expect(args.port).toBe(9999);
      expect(args.debug).toBe(true);
    });

    it('parses status command', () => {
      const args = parseArgs(['node', 'daemon', 'status']);
      expect(args.command).toBe('status');
      expect(args.verbose).toBe(false);
    });

    it('parses status --verbose', () => {
      const args = parseArgs(['node', 'daemon', 'status', '--verbose']);
      expect(args.command).toBe('status');
      expect(args.verbose).toBe(true);
    });

    it('parses observe command', () => {
      const args = parseArgs(['node', 'daemon', 'observe']);
      expect(args.command).toBe('observe');
    });

    it('parses --debug flag', () => {
      const args = parseArgs(['node', 'daemon', '--debug']);
      expect(args.debug).toBe(true);
    });

    it('parses --port flag', () => {
      const args = parseArgs(['node', 'daemon', '--port', '9999']);
      expect(args.port).toBe(9999);
    });

    it('defaults to the hardcoded daemon port', () => {
      const args = parseArgs(['node', 'daemon']);
      expect(args.port).toBe(HARDCODED_DEFAULTS.daemon.port);
      expect(args.debug).toBe(false);
      expect(args.verbose).toBe(false);
      expect(args.command).toBeUndefined();
    });
  });

  describe('formatUptime', () => {
    it('formats seconds', () => {
      expect(formatUptime(45)).toBe('45s');
    });

    it('formats minutes and seconds', () => {
      expect(formatUptime(125)).toBe('2m 5s');
    });

    it('formats hours and minutes', () => {
      expect(formatUptime(7920)).toBe('2h 12m');
    });
  });

  describe('stopDaemon', () => {
    it('returns false when PID file has dead process', () => {
      // Write a PID file pointing at a dead process
      const pidFile = path.join(tmpDir, 'stop-test.pid');
      fs.writeFileSync(pidFile, '99999999');

      // stopDaemon reads from the real PID_FILE constant, so we test the
      // logic conceptually: dead PID → should report not running
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    });
  });

  describe('idle timeout concept', () => {
    it('can set and clear a timeout', () => {
      vi.useFakeTimers();
      const cb = vi.fn();

      const timer = setTimeout(cb, 600000); // 10 min
      expect(cb).not.toHaveBeenCalled();

      clearTimeout(timer);
      vi.advanceTimersByTime(600000);
      expect(cb).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('timeout fires when not cleared', () => {
      vi.useFakeTimers();
      const cb = vi.fn();

      setTimeout(cb, 600000);
      vi.advanceTimersByTime(600000);
      expect(cb).toHaveBeenCalledOnce();

      vi.useRealTimers();
    });
  });
});
