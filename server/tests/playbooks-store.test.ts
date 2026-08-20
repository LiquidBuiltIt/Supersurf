import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  savePlaybook, loadPlaybook, listPlaybooks, removePlaybook,
  playbookExists, normalizeName, setBaseDirForTests,
} from '../src/playbooks/store';
import type { Playbook } from '../src/playbooks/types';

let dir: string;

function makePlaybook(name: string): Playbook {
  return {
    name, purpose: 'test purpose', version: 1, createdAt: 1_700_000_000_000,
    steps: [{ tool: 'browser_interact', type: 'click', params: { type: 'click', selector: '#a' }, url: 'https://x.com/', sourceId: 1 }],
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-store-'));
  setBaseDirForTests(dir);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('playbook store', () => {
  it('round-trips a playbook through disk', () => {
    savePlaybook(makePlaybook('apply_to_job'));
    const loaded = loadPlaybook('apply_to_job');
    expect(loaded).not.toBeNull();
    expect(loaded!.purpose).toBe('test purpose');
    expect(loaded!.steps[0].params).toEqual({ type: 'click', selector: '#a' });
  });

  it('writes one file per playbook, named after it', () => {
    savePlaybook(makePlaybook('login_flow'));
    savePlaybook(makePlaybook('apply_to_job'));
    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(['apply_to_job.json', 'login_flow.json']);
  });

  it('writes playbook files with owner-only permissions', () => {
    savePlaybook(makePlaybook('login_flow'));
    const mode = fs.statSync(path.join(dir, 'login_flow.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('returns null for a missing playbook', () => {
    expect(loadPlaybook('nope')).toBeNull();
  });

  it('returns null rather than throwing on a corrupt file', () => {
    fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');
    expect(loadPlaybook('broken')).toBeNull();
  });

  it('lists all playbooks and skips corrupt files', () => {
    savePlaybook(makePlaybook('a_flow'));
    savePlaybook(makePlaybook('b_flow'));
    fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');
    const all = listPlaybooks();
    expect(all.map(p => p.name).sort()).toEqual(['a_flow', 'b_flow']);
  });

  it('lists nothing when the directory does not exist', () => {
    fs.rmSync(dir, { recursive: true, force: true });
    expect(listPlaybooks()).toEqual([]);
  });

  it('removes a playbook and reports whether it existed', () => {
    savePlaybook(makePlaybook('gone_soon'));
    expect(removePlaybook('gone_soon')).toBe(true);
    expect(removePlaybook('gone_soon')).toBe(false);
    expect(loadPlaybook('gone_soon')).toBeNull();
  });

  it('reports existence without parsing', () => {
    savePlaybook(makePlaybook('here'));
    expect(playbookExists('here')).toBe(true);
    expect(playbookExists('not_here')).toBe(false);
  });

  it('normalizes names to snake_case rather than rejecting them', () => {
    expect(normalizeName('Apply To Job')).toBe('apply_to_job');
    expect(normalizeName('apply-to-job')).toBe('apply_to_job');
    expect(normalizeName('  Apply__To  Job ')).toBe('apply_to_job');
  });

  it('strips path separators from names so a playbook cannot escape its directory', () => {
    expect(normalizeName('../../etc/passwd')).toBe('etc_passwd');
    savePlaybook(makePlaybook(normalizeName('../evil')));
    expect(fs.readdirSync(dir)).toEqual(['evil.json']);
  });
});
