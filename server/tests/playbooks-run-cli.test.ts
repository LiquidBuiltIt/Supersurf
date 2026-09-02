import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setPlaybooksDirForTests } from '../src/playbooks/paths';
import { setValidatorForTests, resetRegistryForTests } from '../src/playbooks/registry';
import { parseParamFlags, runRun } from '../src/playbooks/run-cli';
import type { ValidationRecord } from '../src/security/validate';
import type { RunOutcome } from '../src/playbooks/runner';

let dir: string;

/** The verdict `refreshRegistry` will cache for whatever file it finds. */
let verdict: (file: string) => ValidationRecord;

function okRecord(file: string, over: Partial<ValidationRecord> = {}): ValidationRecord {
  return {
    file,
    name: path.basename(file).replace(/\.playbook\.js$/, ''),
    hash: 'h',
    valid: true,
    meta: {
      description: 'posts a tweet',
      params: {
        text: { type: 'string', required: true },
        count: { type: 'number' },
        pin: { type: 'boolean' },
      },
    },
    signature: 'post_tweet(text)',
    validatedAt: Date.now(),
    ...over,
  };
}

/** Drop a real file on disk so `listPlaybookFiles` sees it; the validator is faked. */
function seed(name = 'post_tweet'): string {
  const file = path.join(dir, `${name}.playbook.js`);
  fs.writeFileSync(file, `export const meta = { description: 'x' };\n`);
  return file;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-run-cli-'));
  setPlaybooksDirForTests(dir);
  resetRegistryForTests();
  verdict = (file) => okRecord(file);
  setValidatorForTests(async (file: string) => verdict(file));
});

afterEach(() => {
  setValidatorForTests(null);
  resetRegistryForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Capture the two output channels `runRun` writes to. */
function sink(): { out: string[]; err: string[]; log: (m: string) => void; errLog: (m: string) => void } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (m: string) => out.push(m), errLog: (m: string) => err.push(m) };
}

function outcome(over: Partial<RunOutcome> = {}): RunOutcome {
  return { ok: true, durationMs: 12, logs: [], ...over };
}

describe('parseParamFlags', () => {
  const meta = okRecord('/x/post_tweet.playbook.js').meta!;

  it('leaves a declared string param as a string', () => {
    expect(parseParamFlags(['text=hi there'], meta)).toEqual({ params: { text: 'hi there' } });
  });

  it('coerces a declared number param', () => {
    expect(parseParamFlags(['count=3'], meta)).toEqual({ params: { count: 3 } });
  });

  it('rejects a non-numeric value for a number param', () => {
    expect(parseParamFlags(['count=lots'], meta).error).toContain('expected a number');
  });

  it('coerces a declared boolean param', () => {
    expect(parseParamFlags(['pin=true'], meta)).toEqual({ params: { pin: true } });
    expect(parseParamFlags(['pin=false'], meta)).toEqual({ params: { pin: false } });
  });

  it('rejects a non-boolean value for a boolean param', () => {
    expect(parseParamFlags(['pin=yes'], meta).error).toContain('expected true or false');
  });

  it('leaves an UNDECLARED key as a string so validateParams can reject it by name', () => {
    expect(parseParamFlags(['nope=1'], meta)).toEqual({ params: { nope: '1' } });
  });

  it('rejects a pair with no `=` and a pair with an empty key', () => {
    expect(parseParamFlags(['text'], meta).error).toContain('key=value');
    expect(parseParamFlags(['=hi'], meta).error).toContain('key=value');
  });

  it('keeps `=` inside the value', () => {
    expect(parseParamFlags(['text=a=b'], meta)).toEqual({ params: { text: 'a=b' } });
  });
});

describe('runRun — the terminal run path', () => {
  it('invokes the runner with caller: \'cli\'', async () => {
    seed();
    const s = sink();
    const seen: any[] = [];
    const code = await runRun('post_tweet', { param: ['text=hi'] }, {
      ...s,
      runPlaybook: async (o) => { seen.push(o); return outcome(); },
    });
    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].caller).toBe('cli');
    expect(seen[0].params).toEqual({ text: 'hi' });
  });

  it('forwards --profile as the runner\'s profile override', async () => {
    seed();
    const s = sink();
    const seen: any[] = [];
    await runRun('post_tweet', { param: [], profile: 'developer' }, {
      ...s,
      runPlaybook: async (o) => { seen.push(o); return outcome(); },
    });
    expect(seen[0].profile).toBe('developer');
  });

  it('normalizes the name before it looks the playbook up', async () => {
    seed();
    const s = sink();
    const seen: any[] = [];
    const code = await runRun('Post-Tweet', { param: ['text=hi'] }, {
      ...s,
      runPlaybook: async (o) => { seen.push(o); return outcome(); },
    });
    expect(code).toBe(0);
    expect(seen[0].record.name).toBe('post_tweet');
  });

  // The gate is CALLER-BASED. `tools/playbooks.ts` enforces it because an agent
  // is an untrusted caller; the human at a terminal can read the file first.
  // SUPERSURF_DISABLE_PLAYBOOK_EVAL=1 sets security.playbook_eval false for
  // every ConfigService in the process, so if this path consulted the gate at
  // all, an `eval`-permissioned script would be refused here.
  describe('security.playbook_eval is NOT consulted on this path', () => {
    let saved: string | undefined;
    beforeEach(() => { saved = process.env.SUPERSURF_DISABLE_PLAYBOOK_EVAL; process.env.SUPERSURF_DISABLE_PLAYBOOK_EVAL = '1'; });
    afterEach(() => {
      if (saved === undefined) delete process.env.SUPERSURF_DISABLE_PLAYBOOK_EVAL;
      else process.env.SUPERSURF_DISABLE_PLAYBOOK_EVAL = saved;
    });

    it('runs an `eval`-permissioned script with the gate turned off', async () => {
      seed();
      verdict = (f) => okRecord(f, {
        meta: { description: 'evals', params: {}, permissions: ['eval'] },
      });

      const s = sink();
      const seen: any[] = [];
      const code = await runRun('post_tweet', { param: [] }, {
        ...s,
        runPlaybook: async (o) => { seen.push(o); return outcome(); },
      });

      expect(code).toBe(0);
      expect(seen).toHaveLength(1);
      expect(seen[0].record.meta.permissions).toEqual(['eval']);
      expect(s.err.join('\n')).not.toContain('playbook_eval');
    });

    // Structural backstop for the behavioural test above: the module imports no
    // config reader, so it has no way to reach the gate even by accident. (It
    // names `security.playbook_eval` in prose, explaining why it ignores it —
    // hence the import check rather than a bare grep for the string.)
    it('imports nothing that could read the config', () => {
      const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'playbooks', 'run-cli.ts'), 'utf8');
      const imports = src.match(/^import .*$/gm) ?? [];
      expect(imports.length).toBeGreaterThan(0);
      for (const line of imports) {
        expect(line).not.toMatch(/backend-config|ConfigService|buildConfigService|shared/);
      }
    });
  });

  describe('--json', () => {
    it('prints one JSON line with the run outcome and exits 0 on success', async () => {
      seed();
      const s = sink();
      const code = await runRun('post_tweet', { param: ['text=hi'], json: true }, {
        ...s,
        runPlaybook: async () => outcome({ result: { id: 7 }, durationMs: 340 }),
      });
      expect(code).toBe(0);
      expect(s.out).toHaveLength(1);
      expect(JSON.parse(s.out[0])).toEqual({
        name: 'post_tweet', ok: true, durationMs: 340, result: { id: 7 },
      });
    });

    it('suppresses the streamed run trail (onLog is undefined)', async () => {
      seed();
      const s = sink();
      const seen: any[] = [];
      await runRun('post_tweet', { param: [], json: true }, {
        ...s,
        runPlaybook: async (o) => { seen.push(o); return outcome(); },
      });
      expect(seen[0].onLog).toBeUndefined();
    });

    it('streams the run trail when --json is absent', async () => {
      seed();
      const s = sink();
      const seen: any[] = [];
      await runRun('post_tweet', { param: [] }, {
        ...s,
        runPlaybook: async (o) => { seen.push(o); return outcome(); },
      });
      expect(typeof seen[0].onLog).toBe('function');
      seen[0].onLog('step 1');
      expect(s.out).toContain('  step 1');
    });

    it('carries error and evidence through, and exits 1 on a failed run', async () => {
      seed();
      const s = sink();
      const code = await runRun('post_tweet', { param: [], json: true }, {
        ...s,
        runPlaybook: async () => outcome({
          ok: false, error: 'selector never appeared', durationMs: 900,
          evidence: { snapshot: '<page snapshot>' },
        }),
      });
      expect(code).toBe(1);
      expect(JSON.parse(s.out[0])).toEqual({
        name: 'post_tweet', ok: false, durationMs: 900,
        error: 'selector never appeared',
        evidence: { snapshot: '<page snapshot>' },
      });
    });
  });

  describe('human-readable rendering', () => {
    it('prints a tick line and the result on success', async () => {
      seed();
      const s = sink();
      const code = await runRun('post_tweet', { param: [] }, {
        ...s,
        runPlaybook: async () => outcome({ result: 'done', durationMs: 55 }),
      });
      expect(code).toBe(0);
      expect(s.out[0]).toBe('✓ post_tweet — 55ms');
      expect(s.out[1]).toBe('done');
      expect(s.err).toEqual([]);
    });

    it('pretty-prints a non-string result', async () => {
      seed();
      const s = sink();
      await runRun('post_tweet', { param: [] }, {
        ...s,
        runPlaybook: async () => outcome({ result: { id: 7 } }),
      });
      expect(s.out[1]).toBe(JSON.stringify({ id: 7 }, null, 2));
    });

    // The run's tab is closed by the time this prints, so the snapshot the
    // runner captured before teardown is the only view of the failing page.
    it('dumps evidence.snapshot to stderr on failure and returns 1', async () => {
      seed();
      const s = sink();
      const code = await runRun('post_tweet', { param: [] }, {
        ...s,
        runPlaybook: async () => outcome({
          ok: false, error: 'boom', durationMs: 900,
          evidence: { snapshot: '<the failing page>' },
        }),
      });
      expect(code).toBe(1);
      expect(s.err[0]).toBe('✗ post_tweet — 900ms');
      expect(s.err[1]).toBe('boom');
      expect(s.err[2]).toContain('the run\'s tab is already closed');
      expect(s.err[3]).toBe('<the failing page>');
      expect(s.out).toEqual([]);
    });

    it('omits the snapshot block when the runner captured no evidence', async () => {
      seed();
      const s = sink();
      const code = await runRun('post_tweet', { param: [] }, {
        ...s,
        runPlaybook: async () => outcome({ ok: false, error: 'boom' }),
      });
      expect(code).toBe(1);
      expect(s.err).toHaveLength(2);
      expect(s.err.join('\n')).not.toContain('already closed');
    });

    it('falls back to `unknown error` when a failed run reports no message', async () => {
      seed();
      const s = sink();
      await runRun('post_tweet', { param: [] }, {
        ...s,
        runPlaybook: async () => outcome({ ok: false }),
      });
      expect(s.err[1]).toBe('unknown error');
    });
  });

  describe('refusals — the runner is never reached', () => {
    it('returns 1 and names the playbooks dir for a missing playbook', async () => {
      const s = sink();
      let called = false;
      const code = await runRun('nope', { param: [] }, {
        ...s,
        runPlaybook: async () => { called = true; return outcome(); },
      });
      expect(code).toBe(1);
      expect(called).toBe(false);
      expect(s.err[0]).toContain("No playbook named 'nope'");
      expect(s.err[0]).toContain(dir);
      expect(s.err[0]).toContain('supersurf playbook ls');
    });

    it('returns 1 and quotes the validation error for an invalid playbook', async () => {
      const file = seed();
      verdict = (f) => ({
        file: f, name: path.basename(f).replace(/\.playbook\.js$/, ''),
        hash: 'h', valid: false, error: 'meta.description is required',
        signature: '', validatedAt: Date.now(),
      });
      expect(fs.existsSync(file)).toBe(true);

      const s = sink();
      let called = false;
      const code = await runRun('post_tweet', { param: [] }, {
        ...s,
        runPlaybook: async () => { called = true; return outcome(); },
      });
      expect(code).toBe(1);
      expect(called).toBe(false);
      expect(s.err[0]).toContain("'post_tweet' did not validate");
      expect(s.err[0]).toContain('meta.description is required');
    });

    it('returns 1 on a malformed --param without calling the runner', async () => {
      seed();
      const s = sink();
      let called = false;
      const code = await runRun('post_tweet', { param: ['count=lots'] }, {
        ...s,
        runPlaybook: async () => { called = true; return outcome(); },
      });
      expect(code).toBe(1);
      expect(called).toBe(false);
      expect(s.err[0]).toContain('expected a number');
    });
  });
});

describe('the security.playbook_eval bypass stays unreachable from an agent', () => {
  // run-cli.ts hard-codes `caller: 'cli'`, which deliberately skips the
  // security.playbook_eval gate. That is only sound because the gate is
  // CALLER-based: argv is fixed at launch by the human who can read the script
  // first, and an agent's only channel is an MCP tool call into an
  // already-running process. The moment a second importer exists -- a tool
  // handler, a spawned child, anything an agent can reach -- the gate is void.
  //
  // Nothing else asserts this. Every other test in this file checks how the
  // bypass BEHAVES; this one checks that it stays out of the agent's reach.
  // Without it the gate can evaporate silently with the suite still green.
  const SERVER_SRC = path.resolve(__dirname, '..', 'src');

  function walkTs(dir: string, rel = ''): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      // Skip the retired `.old` convention -- excluded from every build.
      if (e.name.endsWith('.old') || e.name.endsWith('.old.ts')) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...walkTs(abs, r));
      else if (e.name.endsWith('.ts')) out.push(r);
    }
    return out;
  }

  it('is imported by exactly one module — the terminal CLI entrypoint', () => {
    const files = walkTs(SERVER_SRC);
    // Non-vacuity: an empty walk would make this pass for the wrong reason.
    expect(files.length).toBeGreaterThan(20);

    const importers = files.filter((rel) =>
      /['"][^'"]*playbooks\/run-cli['"]/.test(
        fs.readFileSync(path.join(SERVER_SRC, rel), 'utf8'),
      ),
    );
    expect(importers).toEqual(['cli.ts']);
  });

  it('names `caller` as cli in exactly one place across the server source', () => {
    const files = walkTs(SERVER_SRC);
    const sites = files.filter((rel) =>
      /caller:\s*['"]cli['"]/.test(fs.readFileSync(path.join(SERVER_SRC, rel), 'utf8')),
    );
    expect(sites).toEqual(['playbooks/run-cli.ts']);
  });
});
