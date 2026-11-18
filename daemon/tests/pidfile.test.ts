import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { acquirePidFile, releaseFiles, clearStaleSocket, sockIdentity } from '../src/pidfile';

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

    it('takes over a pidfile that holds this process own pid', () => {
      fs.writeFileSync(pidFile, String(process.pid));
      expect(acquirePidFile(pidFile)).toEqual({ acquired: true });
      expect(fs.readFileSync(pidFile, 'utf8')).toBe(String(process.pid));
    });

    it('waits out a writer that created the pidfile but has not written it yet', async () => {
      // A rival daemon: open(O_EXCL) leaves the file empty until the write lands.
      const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile)},'',{flag:'wx'});`
        + `console.log('ready');setTimeout(()=>fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid)),150);setTimeout(()=>{},3000);`;
      const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
      try {
        await new Promise<void>((r) => child.stdout!.once('data', () => r()));
        expect(acquirePidFile(pidFile)).toEqual({ acquired: false, pid: child.pid });
        expect(fs.readFileSync(pidFile, 'utf8')).toBe(String(child.pid));
      } finally {
        child.kill('SIGKILL');
      }
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
      releaseFiles(pidFile, sockFile, { ...sockIdentity(sockFile), ino: sockIdentity(sockFile).ino + 1 });
      expect(fs.existsSync(sockFile)).toBe(true);
    });

    it('removes the socket whose inode this process bound', () => {
      fs.writeFileSync(sockFile, '');
      releaseFiles(pidFile, sockFile, sockIdentity(sockFile));
      expect(fs.existsSync(sockFile)).toBe(false);
    });

    it('keeps a socket with the same inode but a different ctime (inode reuse)', async () => {
      fs.writeFileSync(sockFile, '');
      const bound = sockIdentity(sockFile);
      await new Promise((r) => setTimeout(r, 20));
      fs.chmodSync(sockFile, 0o600); // bumps ctime, keeps the inode
      expect(sockIdentity(sockFile).ino).toBe(bound.ino);
      releaseFiles(pidFile, sockFile, bound);
      expect(fs.existsSync(sockFile)).toBe(true);
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
