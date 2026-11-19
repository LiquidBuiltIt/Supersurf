import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

const HOST = path.resolve(__dirname, '../dist/engine/security/sandbox/host.js');
const HINT = 'run npm run build.engine && npm run build.daemon';

/** Pids of sandbox children (`child.js`) that are direct children of this process. */
const sandboxChildren = (): number[] => {
  try {
    return execFileSync('pgrep', ['-P', String(process.pid), '-f', 'sandbox/child'], { encoding: 'utf8' })
      .split('\n').filter(Boolean).map(Number);
  } catch { return []; } // pgrep exits 1 on no match
};
/**
 * Still running. A zombie counts as gone: the child has exited, but the worker's event loop died with it
 * and nothing waits on the pid, so `kill(pid, 0)` keeps succeeding until the daemon exits.
 */
const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^State:\s+Z/m.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8')); } catch { return false; }
};

// Real Worker + the BUILT sandbox host: terminating the worker mid playbook run must not leave the child behind.
describe('engine worker killed mid playbook run (built host, real child)', () => {
  let tmp: string;
  let worker: Worker | undefined;
  const started: number[] = [];

  afterEach(() => {
    void worker?.terminate();
    for (const pid of started.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('the sandbox child is gone within 3 s of worker.terminate()', async () => {
    if (!fs.existsSync(HOST)) throw new Error(`${HOST} is missing: ${HINT}`);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2c-orphan-'));
    const source = 'export default async function ({ supersurf }) { await supersurf.wait(600000); }\n';
    const file = path.join(tmp, 'hang.playbook.js');
    fs.writeFileSync(file, source);
    const hash = crypto.createHash('sha256').update(source, 'utf8').digest('hex');

    const before = new Set(sandboxChildren());
    // The command the script sends is never answered, so the run (and its child) never finishes.
    worker = new Worker(`
      const { parentPort, workerData: d } = require('node:worker_threads');
      require(d.host).runPlaybookScript({
        file: d.file, hash: d.hash, params: {}, meta: { description: 'hang' },
        onLog: () => {}, onCommand: () => { parentPort.postMessage('cmd'); return new Promise(() => {}); },
      });
    `, { eval: true, workerData: { host: HOST, file, hash }, env: { HOME: tmp } });

    await new Promise<void>((resolve, reject) => {
      worker!.once('message', () => resolve());
      worker!.once('error', reject);
      setTimeout(() => reject(new Error('the playbook never sent its command')), 10_000);
    });
    const pids = sandboxChildren().filter((p) => !before.has(p));
    started.push(...pids);
    expect(pids).toHaveLength(1);
    expect(alive(pids[0])).toBe(true);

    await worker.terminate();
    const deadline = Date.now() + 3000;
    while (alive(pids[0]) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pids[0])).toBe(false);
  });
});
