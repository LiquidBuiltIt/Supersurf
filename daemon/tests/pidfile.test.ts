import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { acquirePidFile, releaseFiles, clearStaleSocket } from '../src/pidfile';

const DEAD_PID = 99999999; // above kernel.pid_max: reliably dead

describe('pidfile lock (M4)', () => {
  let dir: string;
  let pidFile: string;
  let sockFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidfile-'));
    pidFile = path.join(dir, 'daemon.pid');
    sockFile = path.join(dir, 'daemon.sock');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  describe('acquirePidFile', () => {
    it('creates the pidfile mode 0600 holding this pid', () => {
      expect(acquirePidFile(pidFile)).toEqual({ acquired: true });
      expect(fs.readFileSync(pidFile, 'utf8')).toBe(String(process.pid));
      expect(fs.statSync(pidFile).mode & 0o777).toBe(0o600);
    });

    it('refuses when the file names a live process, and leaves it alone', () => {
      fs.writeFileSync(pidFile, String(process.ppid));
      expect(acquirePidFile(pidFile)).toEqual({ acquired: false, pid: process.ppid });
      expect(fs.readFileSync(pidFile, 'utf8')).toBe(String(process.ppid));
    });

    it('replaces a pidfile naming a dead process', () => {
      fs.writeFileSync(pidFile, String(DEAD_PID));
      expect(acquirePidFile(pidFile)).toEqual({ acquired: true });
      expect(fs.readFileSync(pidFile, 'utf8')).toBe(String(process.pid));
    });

    it('replaces an unparsable pidfile', () => {
      fs.writeFileSync(pidFile, 'garbage');
      expect(acquirePidFile(pidFile)).toEqual({ acquired: true });
    });
  });

  describe('releaseFiles (content-matched)', () => {
    it("keeps a pidfile that holds another daemon's pid", () => {
      fs.writeFileSync(pidFile, String(process.ppid));
      releaseFiles(pidFile, sockFile, null);
      expect(fs.readFileSync(pidFile, 'utf8')).toBe(String(process.ppid));
    });

    it('removes a pidfile that holds this pid', () => {
      fs.writeFileSync(pidFile, String(process.pid));
      releaseFiles(pidFile, sockFile, null);
      expect(fs.existsSync(pidFile)).toBe(false);
    });

    it('keeps a socket this process never bound', () => {
      fs.writeFileSync(sockFile, '');
      releaseFiles(pidFile, sockFile, null);
      expect(fs.existsSync(sockFile)).toBe(true);
    });

    it('keeps a socket whose inode is not the one this process bound', () => {
      fs.writeFileSync(sockFile, '');
      releaseFiles(pidFile, sockFile, fs.lstatSync(sockFile).ino + 1);
      expect(fs.existsSync(sockFile)).toBe(true);
    });

    it('removes the socket whose inode this process bound', () => {
      fs.writeFileSync(sockFile, '');
      releaseFiles(pidFile, sockFile, fs.lstatSync(sockFile).ino);
      expect(fs.existsSync(sockFile)).toBe(false);
    });
  });

  describe('clearStaleSocket', () => {
    it('is a no-op without a socket file', async () => {
      expect(await clearStaleSocket(sockFile)).toBe(true);
    });

    it('unlinks a socket file nothing listens on', async () => {
      const srv = net.createServer();
      await new Promise<void>((r) => srv.listen(sockFile, r));
      // Closing unlinks the path; recreate the dead file by hand.
      await new Promise<void>((r) => srv.close(() => r()));
      fs.writeFileSync(sockFile, '');
      expect(await clearStaleSocket(sockFile)).toBe(true);
      expect(fs.existsSync(sockFile)).toBe(false);
    });

    it('reports a live listener and leaves its socket in place', async () => {
      const srv = net.createServer();
      await new Promise<void>((r) => srv.listen(sockFile, r));
      expect(await clearStaleSocket(sockFile)).toBe(false);
      expect(fs.existsSync(sockFile)).toBe(true);
      await new Promise<void>((r) => srv.close(() => r()));
    });
  });
});
