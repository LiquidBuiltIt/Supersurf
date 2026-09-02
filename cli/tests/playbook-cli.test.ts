import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setPlaybooksDirForTests, playbookFile } from '../../server/src/playbooks/paths';
import { resetRegistryForTests, setValidatorForTests } from '../../server/src/playbooks/registry';
import {
  buildPlaybookProgram, runLs, runInspect, runValidate, runRun, parseParamFlags,
} from '../src/playbook-cli';
import type { ValidationRecord } from '../../server/src/security/validate';
import { VERSION } from '../src/version';

/**
 * `run` no longer runs anything in-process — it shells out to the pinned
 * `supersurf-mcp` package (Task 4). The seam these tests used to stub
 * (`RunRunOpts.runPlaybook`) is gone with it, so the assertion moves down a
 * level: what matters now is the argv handed to `spawn`.
 */
const spawned: { cmd: string; args: string[] }[] = [];
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[]) => {
      spawned.push({ cmd, args });
      return { on: vi.fn(), kill: vi.fn() } as any;
    }),
  };
});

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

describe('runRun shells out instead of loading the runner', () => {
  beforeEach(() => { spawned.length = 0; });

  it('invokes the pinned mcp package with the playbook run subcommand', async () => {
    fs.writeFileSync(playbookFile('post_tweet'), '// ok');
    const { runPlaybookProgram } = await import('../src/playbook-cli');
    await runPlaybookProgram(['node', 'supersurf', 'run', 'post_tweet', '--param', 'text=hi']);
    expect(spawned[0].cmd).toBe('npx');
    expect(spawned[0].args).toContain(`supersurf-mcp@${VERSION}`);
    expect(spawned[0].args.join(' ')).toContain('playbook run post_tweet');
    expect(spawned[0].args.join(' ')).toContain('--param text=hi');
    expect(spawned[0].args).not.toContain('@latest');
  });

  it('forwards --profile and --json exactly as typed', async () => {
    fs.writeFileSync(playbookFile('post_tweet'), '// ok');
    await runRun('post_tweet', { param: ['text=hi'], profile: 'dev', json: true }, opts());
    expect(spawned[0].args.join(' ')).toContain('--profile dev');
    expect(spawned[0].args).toContain('--json');
  });

  it('refuses to run an invalid playbook — nothing is spawned', async () => {
    fs.writeFileSync(playbookFile('broken'), '// bad');
    expect(await runRun('broken', {}, opts())).toBe(1);
    expect(spawned).toEqual([]);
  });

  it('rejects a malformed --param before paying for an npx cold start', async () => {
    fs.writeFileSync(playbookFile('post_tweet'), '// ok');
    expect(await runRun('post_tweet', { param: ['justakey'] }, opts())).toBe(1);
    expect(err.join('\n')).toContain('key=value');
    expect(spawned).toEqual([]);
  });

  it('names the playbook and the directory when it does not exist', async () => {
    expect(await runRun('nope', {}, opts())).toBe(1);
    expect(err.join('\n')).toContain('No playbook named');
    expect(spawned).toEqual([]);
  });
});
