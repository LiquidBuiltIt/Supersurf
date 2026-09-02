/**
 * `supersurf playbook run` — the terminal-side run entrypoint, server half.
 *
 * `ls`, `inspect`, `validate` and `migrate` live in the compiled `supersurf`
 * binary (`cli/`) and stay there: they are daemon-free and dependency-light.
 * `run` cannot follow them. It reaches `playbooks/runner.ts` and therefore the
 * ConnectionManager, the daemon and `tools/` — including `tools/screenshot.ts`,
 * the tree's only `sharp` importer. Compiling that into the binary would
 * reinstate the per-platform native-addon build matrix the extraction removed.
 * So the binary shells out to `npx supersurf-mcp@<version> playbook run …`, and
 * this module is what receives that argv.
 *
 * `run` at a terminal IGNORES `security.playbook_eval`. That gate exists
 * because an agent is an untrusted caller; the human running this command can
 * read the file first, so gating them would be theatre. It is enforced in
 * `tools/playbooks.ts`, on the agent path, and deliberately nowhere else.
 *
 * The caller runs the same name/validity/param pre-flight before it shells out,
 * so a typo fails without paying an npx cold start. That is the caller's
 * convenience, not this module's guarantee — the server validates its own
 * input rather than trusting an argv it did not build.
 *
 * @module playbooks/run-cli
 */

import { getPlaybooksDir, normalizeName } from './paths';
import { refreshRegistry, getRecord } from './registry';
import { runPlaybook as realRunPlaybook, type RunOutcome } from './runner';
import type { PlaybookMeta } from '../security/meta';

export interface RunOpts {
  log?: (msg: string) => void;
  errLog?: (msg: string) => void;
}

export interface RunRunOpts extends RunOpts {
  runPlaybook?: (opts: any) => Promise<RunOutcome>;
}

/**
 * Turn repeated `--param key=value` flags into a params object, coercing to
 * the type `meta` declares. An undeclared key stays a string on purpose:
 * `validateParams` rejects it by name, which is a better error than a coercion
 * failure on a param that does not exist.
 */
export function parseParamFlags(
  pairs: string[],
  meta: PlaybookMeta,
): { params?: Record<string, unknown>; error?: string } {
  const spec = meta.params ?? {};
  const params: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) return { error: `--param expects key=value, got \`${pair}\`` };
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    const type = spec[key]?.type;
    if (type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { error: `--param ${key}: expected a number, got \`${raw}\`` };
      params[key] = n;
    } else if (type === 'boolean') {
      if (raw !== 'true' && raw !== 'false') return { error: `--param ${key}: expected true or false, got \`${raw}\`` };
      params[key] = raw === 'true';
    } else {
      params[key] = raw;
    }
  }
  return { params };
}

export async function runRun(
  name: string,
  flags: { param?: string[]; profile?: string; json?: boolean },
  opts: RunRunOpts = {},
): Promise<number> {
  const log = opts.log ?? console.log;
  const errLog = opts.errLog ?? console.error;
  const run = opts.runPlaybook ?? realRunPlaybook;

  const normalized = normalizeName(name);
  await refreshRegistry();
  const record = getRecord(normalized);
  if (!record) {
    errLog(`[playbook] No playbook named '${normalized}' in ${getPlaybooksDir()}. List them with: supersurf playbook ls`);
    return 1;
  }
  if (!record.valid || !record.meta) {
    errLog(`[playbook] '${normalized}' did not validate — ${record.error ?? 'unknown validation error'}`);
    return 1;
  }

  const parsed = parseParamFlags(flags.param ?? [], record.meta);
  if (parsed.error) { errLog(`[playbook] ${parsed.error}`); return 1; }

  // No `security.playbook_eval` check here, deliberately — see the module docblock.
  const outcome = await run({
    record,
    params: parsed.params!,
    caller: 'cli',
    profile: flags.profile,
    onLog: flags.json ? undefined : (m: string) => log(`  ${m}`),
  });

  if (flags.json) {
    log(JSON.stringify({
      name: normalized, ok: outcome.ok, durationMs: outcome.durationMs,
      ...(outcome.result !== undefined ? { result: outcome.result } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
    }));
    return outcome.ok ? 0 : 1;
  }

  if (outcome.ok) {
    log(`✓ ${normalized} — ${outcome.durationMs}ms`);
    if (outcome.result !== undefined) {
      log(typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result, null, 2));
    }
    return 0;
  }

  errLog(`✗ ${normalized} — ${outcome.durationMs}ms`);
  errLog(outcome.error ?? 'unknown error');
  if (outcome.evidence?.snapshot) {
    errLog('Page at the point of failure (the run\'s tab is already closed):');
    errLog(outcome.evidence.snapshot);
  }
  return 1;
}
