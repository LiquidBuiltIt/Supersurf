import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setPlaybooksDirForTests, getPlaybooksDir, playbookFile } from '../src/playbooks/paths';
import { toScript, stepToSource, runMigrate } from '../src/playbooks/migrate';

let dir: string;
let out: string[];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-mig-'));
  setPlaybooksDirForTests(dir);
  out = [];
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const NEXTDOOR = {
  name: 'nextdoor_inbox_check',
  purpose: 'Read-only check of Nextdoor DM inbox and notifications for unread items',
  steps: [
    { tool: 'browser_navigate', type: 'browser_navigate', params: { action: 'url', url: 'https://nextdoor.com/inbox/' }, sourceId: 133 },
    { tool: 'browser_interact', type: 'wait', params: { type: 'wait', timeout: 2000 }, sourceId: 135 },
    { tool: 'browser_snapshot', type: 'browser_snapshot', params: {}, sourceId: 136 },
  ],
  createdAt: 1787707384510, version: 1, profile: 'reselling-fb',
};

const GITHUB = {
  name: 'github_repo_open_issues_check',
  purpose: 'Open a GitHub repo Issues tab and pull the page content',
  steps: [
    { tool: 'browser_interact', type: 'click', params: { type: 'click', selector: 'a:has-text("Issues")', name: 'issues_tab_link' }, url: 'https://github.com/LiquidBuiltIt/Supersurf', sourceId: 5 },
    { tool: 'browser_extract_content', type: 'browser_extract_content', params: { mode: 'selector', selector: 'main', max_lines: 15 }, url: 'https://github.com/LiquidBuiltIt/Supersurf', sourceId: 6 },
  ],
  createdAt: 1787369683467, version: 1,
};

describe('stepToSource', () => {
  it('maps a navigate step to goto', () => {
    expect(stepToSource(NEXTDOOR.steps[0] as any).line).toBe("  await supersurf.goto('https://nextdoor.com/inbox/');");
  });

  it('maps an interact wait with a timeout to a numeric wait', () => {
    expect(stepToSource(NEXTDOOR.steps[1] as any).line).toBe('  await supersurf.wait(2000);');
  });

  it('maps a click, dropping the recorder-only name/purpose fields', () => {
    expect(stepToSource(GITHUB.steps[0] as any).line)
      .toBe('  await supersurf.click(\'a:has-text("Issues")\');');
  });

  it('maps a snapshot to a bare call', () => {
    expect(stepToSource(NEXTDOOR.steps[2] as any).line).toBe('  await supersurf.snapshot();');
  });

  it('maps extract with its recorded options', () => {
    const s = stepToSource(GITHUB.steps[1] as any);
    expect(s.line).toContain('supersurf.extract(');
    expect(s.line).toContain("mode: 'selector'");
    expect(s.manual).toBe(false);
  });

  it('flags an unmappable step for hand-finishing instead of guessing', () => {
    const s = stepToSource({ tool: 'browser_teleport', type: 'browser_teleport', params: { to: 'mars' }, sourceId: 1 } as any);
    expect(s.manual).toBe(true);
    expect(s.line).toContain('TODO');
    expect(s.line).toContain('browser_teleport');
  });
});

describe('toScript', () => {
  it('maps purpose to meta.description and profile to meta.profile', () => {
    const src = toScript(NEXTDOOR as any);
    expect(src).toContain("description: 'Read-only check of Nextdoor DM inbox and notifications for unread items'");
    expect(src).toContain("profile: 'reselling-fb'");
  });

  it('derives startingPoint from the first navigate step url', () => {
    expect(toScript(NEXTDOOR as any)).toContain("startingPoint: 'nextdoor.com'");
  });

  it('falls back to the first step url when there is no navigate step', () => {
    expect(toScript(GITHUB as any)).toContain("startingPoint: 'github.com'");
  });

  it('emits no params — a recording has none', () => {
    expect(toScript(NEXTDOOR as any)).not.toContain('params:');
  });

  it('emits a default export taking { supersurf }', () => {
    expect(toScript(NEXTDOOR as any)).toContain('export default async function ({ supersurf })');
  });

  it('escapes a single quote in the purpose', () => {
    const src = toScript({ ...NEXTDOOR, purpose: "don't break" } as any);
    expect(src).toContain("description: 'don\\'t break'");
  });
});

describe('runMigrate', () => {
  const log = () => ({ log: (m: string) => out.push(m) });

  it('reports nothing to do on an empty directory', async () => {
    expect(await runMigrate({}, log())).toBe(0);
    expect(out.join('\n')).toContain('No legacy JSON playbooks');
  });

  it('writes one .playbook.js per JSON file', async () => {
    fs.writeFileSync(path.join(getPlaybooksDir(), 'nextdoor_inbox_check.json'), JSON.stringify(NEXTDOOR));
    expect(await runMigrate({}, log())).toBe(0);
    expect(fs.existsSync(playbookFile('nextdoor_inbox_check'))).toBe(true);
    expect(fs.readFileSync(playbookFile('nextdoor_inbox_check'), 'utf8')).toContain('supersurf.goto');
  });

  it('leaves the JSON in place — migration is not deletion', async () => {
    const src = path.join(getPlaybooksDir(), 'nextdoor_inbox_check.json');
    fs.writeFileSync(src, JSON.stringify(NEXTDOOR));
    await runMigrate({}, log());
    expect(fs.existsSync(src)).toBe(true);
  });

  it('refuses to overwrite an existing script', async () => {
    fs.writeFileSync(path.join(getPlaybooksDir(), 'nextdoor_inbox_check.json'), JSON.stringify(NEXTDOOR));
    fs.writeFileSync(playbookFile('nextdoor_inbox_check'), '// mine');
    await runMigrate({}, log());
    expect(fs.readFileSync(playbookFile('nextdoor_inbox_check'), 'utf8')).toBe('// mine');
    expect(out.join('\n')).toContain('skipped');
  });

  it('writes nothing under --dry-run but still reports', async () => {
    fs.writeFileSync(path.join(getPlaybooksDir(), 'nextdoor_inbox_check.json'), JSON.stringify(NEXTDOOR));
    expect(await runMigrate({ dryRun: true }, log())).toBe(0);
    expect(fs.existsSync(playbookFile('nextdoor_inbox_check'))).toBe(false);
    expect(out.join('\n')).toContain('nextdoor_inbox_check');
  });

  it('reports the count of steps needing hand-finishing', async () => {
    fs.writeFileSync(path.join(getPlaybooksDir(), 'weird.json'), JSON.stringify({
      ...NEXTDOOR, name: 'weird',
      steps: [{ tool: 'browser_teleport', type: 'browser_teleport', params: {}, sourceId: 1 }],
    }));
    await runMigrate({}, log());
    expect(out.join('\n')).toContain('1 step needs hand-finishing');
  });

  it('reports a malformed JSON file instead of throwing', async () => {
    fs.writeFileSync(path.join(getPlaybooksDir(), 'bad.json'), '{not json');
    expect(await runMigrate({}, log())).toBe(1);
    expect(out.join('\n')).toContain('bad.json');
  });
});
