import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { supersurfDir, sockPath, pidPath, readDaemonPid, isDaemonRunning } from '../daemon-paths';

describe('daemon-paths', () => {
  let origHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    origHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-paths-'));
    process.env.HOME = tmpHome;
    fs.mkdirSync(path.join(tmpHome, '.supersurf'));
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('computes paths from HOME set after import', () => {
    expect(supersurfDir()).toBe(path.join(tmpHome, '.supersurf'));
    expect(sockPath()).toBe(path.join(tmpHome, '.supersurf', 'daemon.sock'));
    expect(pidPath()).toBe(path.join(tmpHome, '.supersurf', 'daemon.pid'));
  });

  it('isDaemonRunning is false with no pidfile', () => {
    expect(isDaemonRunning()).toBe(false);
  });

  it('isDaemonRunning is true for a live pid', () => {
    fs.writeFileSync(pidPath(), String(process.pid));
    expect(readDaemonPid()).toBe(process.pid);
    expect(isDaemonRunning()).toBe(true);
  });

  it('isDaemonRunning is false for a dead pid', () => {
    fs.writeFileSync(pidPath(), '99999999');
    expect(isDaemonRunning()).toBe(false);
  });

  it('treats a non-numeric pidfile as not running', () => {
    fs.writeFileSync(pidPath(), 'not-a-pid');
    expect(readDaemonPid()).toBeNull();
    expect(isDaemonRunning()).toBe(false);
  });
});
