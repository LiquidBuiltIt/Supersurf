import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runLs, runShow, runRm, runExport, runImport, runEdit } from '../src/bin/playbook-cli';
import { savePlaybook, loadPlaybook, setBaseDirForTests } from '../src/playbooks/store';
import type { Playbook } from '../src/playbooks/types';

let dir: string;
let out: string[];
const log = (m: string) => { out.push(m); };

function makePlaybook(name: string, stepCount = 2): Playbook {
  return {
    name, purpose: `purpose of ${name}`, version: 1, createdAt: 1_700_000_000_000,
    steps: Array.from({ length: stepCount }, (_, i) => ({
      tool: 'browser_interact', type: i === 0 ? 'click' : 'type',
      params: { type: i === 0 ? 'click' : 'type', selector: `#el${i}`, name: `handle_${i}` },
      url: 'https://example.com/page', sourceId: i + 1,
    })),
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-cli-'));
  setBaseDirForTests(dir);
  out = [];
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('playbook ls', () => {
  it('lists saved playbooks with step counts', async () => {
    savePlaybook(makePlaybook('apply_to_job', 3));
    savePlaybook(makePlaybook('login_flow', 2));
    await runLs({ log });
    const joined = out.join('\n');
    expect(joined).toContain('apply_to_job');
    expect(joined).toContain('login_flow');
    expect(joined).toContain('3');
  });

  it('says so plainly when there are none', async () => {
    await runLs({ log });
    expect(out.join('\n').toLowerCase()).toContain('no playbooks');
  });
});

describe('playbook show', () => {
  it('prints the steps of a playbook', async () => {
    savePlaybook(makePlaybook('apply_to_job'));
    await runShow('apply_to_job', { log });
    const joined = out.join('\n');
    expect(joined).toContain('apply_to_job');
    expect(joined).toContain('handle_0');
  });

  it('throws on an unknown playbook', async () => {
    await expect(runShow('ghost', { log })).rejects.toThrow(/ghost/);
  });
});

describe('playbook rm', () => {
  it('removes a playbook', async () => {
    savePlaybook(makePlaybook('gone_soon'));
    await runRm('gone_soon', { log });
    expect(loadPlaybook('gone_soon')).toBeNull();
  });

  it('throws on an unknown playbook', async () => {
    await expect(runRm('ghost', { log })).rejects.toThrow(/ghost/);
  });
});

describe('playbook export / import', () => {
  it('exports a playbook to a file', async () => {
    savePlaybook(makePlaybook('apply_to_job'));
    const dest = path.join(dir, 'out.json');
    await runExport('apply_to_job', dest, { log });
    const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
    expect(parsed.name).toBe('apply_to_job');
    expect(parsed.steps).toHaveLength(2);
  });

  it('imports a playbook from a file', async () => {
    const src = path.join(dir, 'in.json');
    fs.writeFileSync(src, JSON.stringify(makePlaybook('imported_flow')));
    await runImport(src, { log });
    expect(loadPlaybook('imported_flow')).not.toBeNull();
  });

  it('refuses to import over an existing name', async () => {
    savePlaybook(makePlaybook('dupe'));
    const src = path.join(dir, 'in.json');
    fs.writeFileSync(src, JSON.stringify(makePlaybook('dupe')));
    await expect(runImport(src, { log })).rejects.toThrow(/already exists/);
  });

  it('rejects a file that is not a playbook', async () => {
    const src = path.join(dir, 'junk.json');
    fs.writeFileSync(src, JSON.stringify({ hello: 'world' }));
    await expect(runImport(src, { log })).rejects.toThrow();
  });
});

describe('playbook edit', () => {
  it('drops the named step and renumbers the rest', async () => {
    savePlaybook(makePlaybook('trim_me', 3));
    await runEdit('trim_me', { drop: '2' }, { log });
    const pb = loadPlaybook('trim_me')!;
    expect(pb.steps).toHaveLength(2);
    expect(pb.steps[0].params).toMatchObject({ selector: '#el0' });
    expect(pb.steps[1].params).toMatchObject({ selector: '#el2' });
  });

  it('throws on an out-of-range step number', async () => {
    savePlaybook(makePlaybook('trim_me', 2));
    await expect(runEdit('trim_me', { drop: '9' }, { log })).rejects.toThrow(/9/);
  });

  it('refuses to drop the last remaining step', async () => {
    savePlaybook(makePlaybook('only_one', 1));
    await expect(runEdit('only_one', { drop: '1' }, { log })).rejects.toThrow();
  });
});
