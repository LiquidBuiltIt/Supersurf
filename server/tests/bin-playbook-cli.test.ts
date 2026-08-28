import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setPlaybooksDirForTests, playbookFile } from '../src/playbooks/paths';
import { resetRegistryForTests, setValidatorForTests } from '../src/playbooks/registry';
import {
  buildPlaybookProgram, runLs, runInspect, runValidate, runRun, parseParamFlags,
} from '../src/bin/playbook-cli';
import type { ValidationRecord } from '../src/security/validate';

let dir: string;
let out: string[];
let err: string[];

const META = { description: 'posts a tweet', params: { text: { type: 'string' as const, required: true } }, startingPoint: 'x.com' };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-cli-'));
  setPlaybooksDirForTests(dir);
  resetRegistryForTests();
  out = []; err = [];
  setValidatorForTests(async (p: string): Promise<ValidationRecord> => {
    const name = path.basename(p).replace('.playbook.js', '');
    return name === 'broken'
      ? { file: p, name, hash: 'h', valid: false, error: 'blocked API: require', signature: '', validatedAt: 1 }
      : { file: p, name, hash: 'h', valid: true, meta: META, signature: `${name}({ text })`, validatedAt: 1 };
  });
});
afterEach(() => {
  setValidatorForTests(null);
  resetRegistryForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

const opts = () => ({ log: (m: string) => out.push(m), errLog: (m: string) => err.push(m) });

describe('command set', () => {
  it('exposes exactly ls, inspect, validate, run, migrate', () => {
    expect(buildPlaybookProgram().commands.map(c => c.name()).sort())
      .toEqual(['inspect', 'ls', 'migrate', 'run', 'validate']);
  });
});

describe('runLs', () => {
  it('reports an empty directory', async () => {
    await runLs(opts());
    expect(out.join('\n')).toContain('(no playbooks');
  });

  it('lists signatures and flags invalid files', async () => {
    fs.writeFileSync(playbookFile('post_tweet'), '// ok');
    fs.writeFileSync(playbookFile('broken'), '// bad');
    await runLs(opts());
    const body = out.join('\n');
    expect(body).toContain('post_tweet({ text })');
    expect(body).toContain('blocked API: require');
  });
});

describe('runInspect', () => {
  it('exits non-zero for an unknown name', async () => {
    expect(await runInspect('nope', opts())).toBe(1);
    expect(err.join('\n')).toContain('No playbook named');
  });

  it('prints the params for a known name', async () => {
    fs.writeFileSync(playbookFile('post_tweet'), '// ok');
    expect(await runInspect('post_tweet', opts())).toBe(0);
    expect(out.join('\n')).toContain('text');
  });
});

describe('runValidate', () => {
  it('returns 0 when everything validates', async () => {
    fs.writeFileSync(playbookFile('post_tweet'), '// ok');
    expect(await runValidate(undefined, opts())).toBe(0);
  });

  it('returns 1 and names the offender when something does not', async () => {
    fs.writeFileSync(playbookFile('broken'), '// bad');
    expect(await runValidate(undefined, opts())).toBe(1);
    expect(err.join('\n') + out.join('\n')).toContain('broken');
  });
});

describe('parseParamFlags', () => {
  it('coerces to the declared types', () => {
    const meta = { description: 'x', params: {
      s: { type: 'string' as const }, n: { type: 'number' as const }, b: { type: 'boolean' as const },
    } };
    expect(parseParamFlags(['s=hi', 'n=42', 'b=true'], meta).params).toEqual({ s: 'hi', n: 42, b: true });
  });

  it('rejects a malformed pair', () => {
    expect(parseParamFlags(['justakey'], { description: 'x' }).error).toContain('key=value');
  });

  it('rejects a non-numeric value for a number param', () => {
    expect(parseParamFlags(['n=abc'], { description: 'x', params: { n: { type: 'number' as const } } }).error)
      .toContain('n');
  });

  it('keeps an undeclared param as a string so validateParams can reject it by name', () => {
    expect(parseParamFlags(['zzz=1'], { description: 'x' }).params).toEqual({ zzz: '1' });
  });
});

describe('runRun', () => {
  it('ignores security.playbook_eval — the terminal caller is trusted', async () => {
    fs.writeFileSync(playbookFile('post_tweet'), '// ok');
    setValidatorForTests(async (p: string) => ({
      file: p, name: 'post_tweet', hash: 'h', valid: true,
      meta: { ...META, permissions: ['eval'] }, signature: 'post_tweet({ text })', validatedAt: 1,
    }));
    let seen: any = null;
    const code = await runRun('post_tweet', { param: ['text=hi'] }, {
      ...opts(),
      runPlaybook: async (o: any) => { seen = o; return { ok: true, durationMs: 1, logs: [] }; },
    });
    expect(code).toBe(0);
    expect(seen.caller).toBe('cli');
  });

  it('passes --profile through as an override', async () => {
    fs.writeFileSync(playbookFile('post_tweet'), '// ok');
    let seen: any = null;
    await runRun('post_tweet', { param: ['text=hi'], profile: 'dev' }, {
      ...opts(),
      runPlaybook: async (o: any) => { seen = o; return { ok: true, durationMs: 1, logs: [] }; },
    });
    expect(seen.profile).toBe('dev');
  });

  it('returns 1 and prints the evidence on a failed run', async () => {
    fs.writeFileSync(playbookFile('post_tweet'), '// ok');
    const code = await runRun('post_tweet', { param: ['text=hi'] }, {
      ...opts(),
      runPlaybook: async () => ({ ok: false, error: 'not visible', durationMs: 3, logs: [], evidence: { snapshot: '<page>' } }),
    });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('<page>');
  });

  it('refuses to run an invalid playbook', async () => {
    fs.writeFileSync(playbookFile('broken'), '// bad');
    let called = false;
    const code = await runRun('broken', {}, {
      ...opts(),
      runPlaybook: async () => { called = true; return { ok: true, durationMs: 1, logs: [] }; },
    });
    expect(code).toBe(1);
    expect(called).toBe(false);
  });

  it('emits machine-readable JSON with --json', async () => {
    fs.writeFileSync(playbookFile('post_tweet'), '// ok');
    await runRun('post_tweet', { param: ['text=hi'], json: true }, {
      ...opts(),
      runPlaybook: async () => ({ ok: true, result: { posted: true }, durationMs: 7, logs: [] }),
    });
    expect(JSON.parse(out[0])).toEqual({ name: 'post_tweet', ok: true, result: { posted: true }, durationMs: 7 });
  });
});
