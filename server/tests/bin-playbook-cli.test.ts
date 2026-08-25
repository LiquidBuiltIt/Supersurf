import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runLs, runInspect, runRm, runExport, runImport, runEdit, runRun, buildPlaybookProgram, type RunBackend } from '../src/bin/playbook-cli';
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

describe('playbook inspect', () => {
  it('prints the steps of a playbook', async () => {
    savePlaybook(makePlaybook('apply_to_job'));
    await runInspect('apply_to_job', { log });
    const joined = out.join('\n');
    expect(joined).toContain('apply_to_job');
    expect(joined).toContain('handle_0');
  });

  it('throws on an unknown playbook', async () => {
    await expect(runInspect('ghost', { log })).rejects.toThrow(/ghost/);
  });

  it('is registered as `inspect`, not `show`, in the CLI program', () => {
    const program = buildPlaybookProgram();
    const names = program.commands.map(c => c.name());
    expect(names).toContain('inspect');
    expect(names).not.toContain('show');
  });

  it('mentions `inspect`, not `show`, in the --drop help text', () => {
    const program = buildPlaybookProgram();
    const edit = program.commands.find(c => c.name() === 'edit')!;
    const dropOption = edit.options.find(o => o.long === '--drop')!;
    expect(dropOption.description).toContain('`inspect`');
    expect(dropOption.description).not.toContain('`show`');
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

  it('throws when no terminal is attached and --drop is absent', async () => {
    savePlaybook(makePlaybook('trim_me', 2));
    let called = false;
    await expect(runEdit('trim_me', {}, {
      log, isTTY: false,
      spawnEditor: () => { called = true; return 0; },
    })).rejects.toThrow(/No terminal attached/);
    expect(called).toBe(false);
  });

  it('mentions the direct file path in the no-terminal message', async () => {
    savePlaybook(makePlaybook('trim_me', 2));
    let err: Error | undefined;
    try {
      await runEdit('trim_me', {}, { log, isTTY: false, spawnEditor: () => 0 });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain(path.join(dir, 'trim_me.json'));
  });

  it('throws with the direct file path and --drop when no editor is configured', async () => {
    savePlaybook(makePlaybook('trim_me', 2));
    const prevVisual = process.env.VISUAL;
    const prevEditor = process.env.EDITOR;
    delete process.env.VISUAL;
    delete process.env.EDITOR;
    let called = false;
    let err: Error | undefined;
    try {
      await runEdit('trim_me', {}, {
        log, isTTY: true,
        spawnEditor: () => { called = true; return 0; },
      });
    } catch (e) {
      err = e as Error;
    } finally {
      if (prevVisual === undefined) delete process.env.VISUAL; else process.env.VISUAL = prevVisual;
      if (prevEditor === undefined) delete process.env.EDITOR; else process.env.EDITOR = prevEditor;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain(path.join(dir, 'trim_me.json'));
    expect(err!.message).toContain('--drop');
    expect(called).toBe(false);
    expect(loadPlaybook('trim_me')!.steps).toHaveLength(2);
    const tmpPath = path.join(os.tmpdir(), `supersurf-playbook-trim_me-${process.pid}.json`);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it('throws when the editor fails to launch, cleans up the temp file, and names the command and file path', async () => {
    savePlaybook(makePlaybook('trim_me', 2));
    const prevVisual = process.env.VISUAL;
    const prevEditor = process.env.EDITOR;
    delete process.env.VISUAL;
    process.env.EDITOR = 'nonexistent-editor';
    let tempPathSeen = '';
    let err: Error | undefined;
    try {
      await runEdit('trim_me', {}, {
        log, isTTY: true,
        spawnEditor: (_cmd, args) => {
          tempPathSeen = args[args.length - 1];
          return { status: null, error: new Error('spawn nonexistent-editor ENOENT') };
        },
      });
    } catch (e) {
      err = e as Error;
    } finally {
      if (prevVisual === undefined) delete process.env.VISUAL; else process.env.VISUAL = prevVisual;
      if (prevEditor === undefined) delete process.env.EDITOR; else process.env.EDITOR = prevEditor;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('nonexistent-editor');
    expect(err!.message).toContain(path.join(dir, 'trim_me.json'));
    expect(fs.existsSync(tempPathSeen)).toBe(false);
    expect(loadPlaybook('trim_me')!.steps).toHaveLength(2);
  });

  it('opens the playbook in $EDITOR and saves the edited version', async () => {
    savePlaybook(makePlaybook('trim_me', 3));
    let tempPathSeen = '';
    await runEdit('trim_me', {}, {
      log, isTTY: true,
      spawnEditor: (_cmd, args) => {
        tempPathSeen = args[args.length - 1];
        const pb = JSON.parse(fs.readFileSync(tempPathSeen, 'utf8'));
        pb.steps.pop();
        fs.writeFileSync(tempPathSeen, JSON.stringify(pb, null, 2));
        return 0;
      },
    });
    const pb = loadPlaybook('trim_me')!;
    expect(pb.steps).toHaveLength(2);
    expect(fs.existsSync(tempPathSeen)).toBe(false);
    expect(out.join('\n')).toMatch(/Saved 'trim_me'/);
  });

  it('keeps the temp file and rejects on invalid JSON', async () => {
    savePlaybook(makePlaybook('trim_me', 2));
    let tempPathSeen = '';
    let err: Error | undefined;
    try {
      await runEdit('trim_me', {}, {
        log, isTTY: true,
        spawnEditor: (_cmd, args) => {
          tempPathSeen = args[args.length - 1];
          fs.writeFileSync(tempPathSeen, '{not json');
          return 0;
        },
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain(tempPathSeen);
    expect(fs.existsSync(tempPathSeen)).toBe(true);
    expect(loadPlaybook('trim_me')!.steps).toHaveLength(2);
    fs.rmSync(tempPathSeen, { force: true });
  });

  it('rejects and removes the temp file when the editor exits non-zero', async () => {
    savePlaybook(makePlaybook('trim_me', 2));
    let tempPathSeen = '';
    await expect(runEdit('trim_me', {}, {
      log, isTTY: true,
      spawnEditor: (_cmd, args) => { tempPathSeen = args[args.length - 1]; return 1; },
    })).rejects.toThrow(/Editor exited with status 1/);
    expect(fs.existsSync(tempPathSeen)).toBe(false);
    expect(loadPlaybook('trim_me')!.steps).toHaveLength(2);
  });

  it('logs no changes when the editor leaves the file untouched', async () => {
    savePlaybook(makePlaybook('trim_me', 2));
    await runEdit('trim_me', {}, {
      log, isTTY: true,
      spawnEditor: () => 0,
    });
    expect(out.join('\n')).toMatch(/No changes to 'trim_me'/);
    expect(loadPlaybook('trim_me')!.steps).toHaveLength(2);
  });

  it('prefers VISUAL over EDITOR and splits multi-token commands', async () => {
    savePlaybook(makePlaybook('trim_me', 2));
    const prevVisual = process.env.VISUAL;
    const prevEditor = process.env.EDITOR;
    process.env.VISUAL = 'code --wait';
    process.env.EDITOR = 'vim';
    let seenCmd = '';
    let seenArgs: string[] = [];
    try {
      await runEdit('trim_me', {}, {
        log, isTTY: true,
        spawnEditor: (cmd, args) => { seenCmd = cmd; seenArgs = args; return 0; },
      });
    } finally {
      if (prevVisual === undefined) delete process.env.VISUAL; else process.env.VISUAL = prevVisual;
      if (prevEditor === undefined) delete process.env.EDITOR; else process.env.EDITOR = prevEditor;
    }
    expect(seenCmd).toBe('code');
    expect(seenArgs[0]).toBe('--wait');
    expect(seenArgs[1]).toMatch(/supersurf-playbook-trim_me-\d+\.json$/);
  });
});

function makeMockBackend(overrides: { connectResult?: any; runResult?: any } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const backend: RunBackend = {
    callTool: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === 'connect') {
        return overrides.connectResult ?? { success: true, state: 'active', browser: 'chrome', client_id: 'x' };
      }
      if (name === 'playbooks') {
        return overrides.runResult ?? { content: [{ type: 'text', text: '✓ done' }], isError: false };
      }
      if (name === 'disconnect') {
        return { success: true, state: 'passive' };
      }
      throw new Error(`unexpected tool call: ${name}`);
    },
  };
  return { backend, calls };
}

describe('playbook run', () => {
  it('connects, runs, then disconnects in order on success', async () => {
    savePlaybook(makePlaybook('flow'));
    const { backend, calls } = makeMockBackend();
    const errOut: string[] = [];
    const code = await runRun('flow', {}, { log, errLog: (m) => errOut.push(m), createBackend: () => backend });

    expect(code).toBe(0);
    expect(calls.map((c) => c.name)).toEqual(['connect', 'playbooks', 'disconnect']);
    expect(calls[1].args).toMatchObject({ action: 'run', name: 'flow' });
    expect(out.join('\n')).toContain('✓ done');
    expect(errOut).toHaveLength(0);
  });

  it('exits 1 and reports the failure to stderr when a step fails', async () => {
    savePlaybook(makePlaybook('flow'));
    const { backend, calls } = makeMockBackend({
      runResult: { content: [{ type: 'text', text: 'Stopped at step 2 of 3.' }], isError: true },
    });
    const errOut: string[] = [];
    const code = await runRun('flow', {}, { log, errLog: (m) => errOut.push(m), createBackend: () => backend });

    expect(code).toBe(1);
    expect(errOut.join('\n')).toContain('Stopped at step 2 of 3');
    expect(out).toHaveLength(0);
    expect(calls.map((c) => c.name)).toEqual(['connect', 'playbooks', 'disconnect']);
  });

  it('exits 1 without connecting when the playbook is missing', async () => {
    const { backend, calls } = makeMockBackend();
    let created = false;
    const errOut: string[] = [];
    const code = await runRun('ghost', {}, {
      log, errLog: (m) => errOut.push(m),
      createBackend: () => { created = true; return backend; },
    });

    expect(code).toBe(1);
    expect(created).toBe(false);
    expect(calls).toHaveLength(0);
    expect(errOut.join('\n')).toContain("No playbook named 'ghost'");
  });

  it('exits 1 and still disconnects when connect fails', async () => {
    savePlaybook(makePlaybook('flow'));
    const { backend, calls } = makeMockBackend({
      connectResult: { success: false, error: 'connection_failed', message: 'daemon unreachable' },
    });
    const errOut: string[] = [];
    const code = await runRun('flow', {}, { log, errLog: (m) => errOut.push(m), createBackend: () => backend });

    expect(code).toBe(1);
    expect(errOut.join('\n')).toContain('daemon unreachable');
    expect(calls.map((c) => c.name)).toEqual(['connect', 'disconnect']);
  });

  it('forwards --profile to the connect call', async () => {
    savePlaybook(makePlaybook('flow'));
    const { backend, calls } = makeMockBackend();
    await runRun('flow', { profile: 'dev' }, { log, errLog: () => {}, createBackend: () => backend });

    expect(calls[0].args).toMatchObject({ profile: 'dev' });
  });

  it('falls back to the playbook profile field when no --profile flag is given', async () => {
    const pb = makePlaybook('flow') as any;
    pb.profile = 'work';
    savePlaybook(pb);
    const { backend, calls } = makeMockBackend();
    await runRun('flow', {}, { log, errLog: () => {}, createBackend: () => backend });

    expect(calls[0].args).toMatchObject({ profile: 'work' });
  });

  it('a --profile flag wins over the playbook profile field', async () => {
    const pb = makePlaybook('flow') as any;
    pb.profile = 'work';
    savePlaybook(pb);
    const { backend, calls } = makeMockBackend();
    await runRun('flow', { profile: 'dev' }, { log, errLog: () => {}, createBackend: () => backend });

    expect(calls[0].args).toMatchObject({ profile: 'dev' });
  });

  it('prints JSON instead of the trail when --json is passed', async () => {
    savePlaybook(makePlaybook('flow'));
    const { backend } = makeMockBackend({
      runResult: { content: [{ type: 'text', text: '✓ flow — 2/2 steps.' }], isError: false },
    });
    const code = await runRun('flow', { json: true }, { log, errLog: () => {}, createBackend: () => backend });

    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]);
    expect(parsed).toMatchObject({ name: 'flow', success: true, output: '✓ flow — 2/2 steps.' });
  });
});
