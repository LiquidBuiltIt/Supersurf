import net from 'net';
import type { AddressInfo } from 'net';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { describe, it, expect, afterEach } from 'vitest';
import { portInUse, runReleaseTests } from './release-gate';

const g = (dir: string, ...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });

const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Throwaway git repo on `main` with one commit, removed after each test.
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  fixtures.push(dir);
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 't@example.com');
  g(dir, 'config', 'user.name', 't');
  g(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  g(dir, 'add', '.');
  g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const freePort = async () => { const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo; await new Promise((r) => s.close(r)); return port; };

describe('portInUse', () => {
  it('is true while something listens and false after it closes', async () => {
    const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const { port } = s.address() as AddressInfo;
    expect(await portInUse(port)).toBe(true);
    await new Promise((r) => s.close(r));
    expect(await portInUse(port)).toBe(false);
  });
});

describe('runReleaseTests', () => {
  it('resolves when the command passes and leaves the tree alone', async () => {
    await expect(runReleaseTests(fixture(), { cmd: ['sh', '-c', 'exit 0'], port: await freePort(), stdio: 'pipe' })).resolves.toBeUndefined();
  });
  it('rejects with the exit code when the command fails', async () => {
    await expect(runReleaseTests(fixture(), { cmd: ['sh', '-c', 'exit 3'], port: await freePort(), stdio: 'pipe' })).rejects.toThrow(/exit 3/);
  });
  it('names the actual command, not "npm test", when a custom command fails', async () => {
    await expect(runReleaseTests(fixture(), { cmd: ['sh', '-c', 'exit 3'], port: await freePort(), stdio: 'pipe' })).rejects.toThrow(/^sh -c exit 3 failed/);
  });
  it('reports the spawn error when the command cannot start', async () => {
    await expect(runReleaseTests(fixture(), { cmd: ['no-such-binary-xyz'], port: await freePort(), stdio: 'pipe' })).rejects.toThrow(/ENOENT/);
  });
  it('reports the signal when the command is killed', async () => {
    await expect(runReleaseTests(fixture(), { cmd: ['sh', '-c', 'kill -9 $$'], port: await freePort(), stdio: 'pipe' })).rejects.toThrow(/SIGKILL/);
  });
  it('rejects naming the file when the run changes the tree', async () => {
    await expect(runReleaseTests(fixture(), { cmd: ['sh', '-c', 'echo x > a.txt'], port: await freePort(), stdio: 'pipe' })).rejects.toThrow(/a\.txt/);
  });
  it('refuses before running anything when the port is held, naming the stop command', async () => {
    const dir = fixture();
    const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const { port } = s.address() as AddressInfo;
    await expect(runReleaseTests(dir, { cmd: ['sh', '-c', 'touch ran'], port, stdio: 'pipe' }))
      .rejects.toThrow('npx supersurf-daemon@latest stop');
    expect(existsSync(join(dir, 'ran'))).toBe(false);
    await new Promise((r) => s.close(r));
  });
});
