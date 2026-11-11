import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, SERVER_VERSION, withSandbox, runScriptMode, normalize, expectGolden } from './harness';

const T = 120_000;

describe('golden: connect', () => {
  it('connect then disconnect against a matching daemon', async () => {
    await withSandbox({ version: SERVER_VERSION, activeSessionCount: 1 }, async (sb) => {
      const r = await runScriptMode(sb.home, [
        { id: 1, method: 'connect', params: { client_id: 'golden-connect' } },
        { id: 2, method: 'disconnect', params: {} },
      ]);
      expect(r[1].result.success).toBe(true);
      expectGolden('connect', normalize({ connect: r[1], disconnect: r[2] }, sb.home, SERVER_VERSION));
    });
  }, T);
});

describe('golden: version mismatch (legacy block)', () => {
  it('daemon of another version with another session live: not restarted', async () => {
    await withSandbox({ version: '0.0.1', activeSessionCount: 2 }, async (sb) => {
      const r = await runScriptMode(sb.home, [{ id: 1, method: 'connect', params: { client_id: 'golden-mismatch' } }]);
      expect(r[1].result.error).toBe('version_mismatch');
      expect(r[1].result.message).toContain('The daemon was NOT restarted because 1 other session is currently active on it');
      expectGolden('mismatch-other-sessions', normalize(r[1], sb.home, SERVER_VERSION));
    });
  }, T);

  it('pre-3.0 daemon (no version field) with other sessions live', async () => {
    await withSandbox({ version: null, activeSessionCount: 3 }, async (sb) => {
      const r = await runScriptMode(sb.home, [{ id: 1, method: 'connect', params: { client_id: 'golden-pre3' } }]);
      expect(r[1].result.error).toBe('version_mismatch');
      expect(r[1].result.message).toContain('(daemon: pre-3.0, server:');
      expect(r[1].result.message).toContain('2 other sessions are currently active');
      expectGolden('mismatch-pre-3', normalize(r[1], sb.home, SERVER_VERSION));
    });
  }, T);
});

describe('golden: legacy playbooks run', () => {
  it('runs a fixture playbook through the runner and the sandbox child', async () => {
    await withSandbox({ version: SERVER_VERSION, activeSessionCount: 1 }, async (sb) => {
      const dir = path.join(sb.home, '.supersurf', 'playbooks');
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(path.join(REPO, 'scripts', 'golden', 'fixtures', 'golden.playbook.js'), path.join(dir, 'golden.playbook.js'));
      const r = await runScriptMode(sb.home, [
        { id: 1, method: 'connect', params: { client_id: 'golden-run' } },
        { id: 2, method: 'playbooks', params: { action: 'run', name: 'golden' } },
      ]);
      const text = JSON.stringify(r[2]);
      // Explicit success proof, so a recorded failure can never pass as a golden.
      expect(text, `fake daemon saw: ${sb.daemon.methods.join(',')}`).toContain('golden-result');
      expect(text).not.toContain('"isError":true');
      expectGolden('playbooks-run', normalize(r[2], sb.home, SERVER_VERSION));
    });
  }, T);
});
