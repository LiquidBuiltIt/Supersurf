#!/usr/bin/env node
/**
 * `supersurf playbook` — discover, validate, run and migrate playbook scripts.
 *
 * `ls`/`inspect`/`validate` are daemon-free by design, modelled on `creds.ts`
 * rather than `profiles-cli.ts`: they must work with no daemon running and no
 * browser connected. There is no `create` and no `edit`: a playbook is a
 * JavaScript file, so it is written with an editor, removed with `rm`, and
 * copied with `cp`.
 *
 * `run` at a terminal IGNORES `security.playbook_eval`. That gate exists
 * because an agent is an untrusted caller; the human running this command can
 * read the file first, so gating them would be theatre.
 *
 * @module playbook-cli
 */

import { Command } from 'commander';
import {
  getPlaybooksDir, normalizeName,
  refreshRegistry, getRecord,
  doList, doInspect, doValidate,
  runMigrate,
  type PlaybookMeta,
} from './server-imports';
import { shellOut } from './shell-out';

export interface RunOpts {
  log?: (msg: string) => void;
  errLog?: (msg: string) => void;
}

/** Pull the single text block out of a `playbooks` tool result. */
function body(res: any): string {
  return String(res?.content?.find((b: any) => b?.type === 'text')?.text ?? '');
}

export function buildPlaybookProgram(): Command {
  const program = new Command();
  program
    .name('supersurf playbook')
    .description('Discover, validate, run and migrate SuperSurf playbook scripts');

  program
    .command('ls')
    .description('List playbook scripts with their call signatures')
    .action(async () => { await runLs(); });

  program
    .command('inspect')
    .description('Print one script\'s params, permissions and run history')
    .argument('<name>', 'playbook name')
    .action(async (name: string) => { process.exitCode = await runInspect(name); });

  program
    .command('validate')
    .description('Re-check one script, or every script when no name is given')
    .argument('[name]', 'playbook name')
    .action(async (name?: string) => { process.exitCode = await runValidate(name); });

  program
    .command('run')
    .description('Run a playbook script against a browser (no MCP client needed)')
    .argument('<name>', 'playbook name')
    .option('--param <key=value>', 'script argument; repeat for each param', (v: string, acc: string[]) => acc.concat(v), [] as string[])
    .option('--profile <profile>', 'managed browser profile; overrides the script\'s own default')
    .option('--json', 'print machine-readable JSON instead of the run trail')
    .action(async (name: string, flags: any) => { process.exitCode = await runRun(name, flags); });

  program
    .command('migrate')
    .description('One-shot: convert legacy JSON playbooks to .playbook.js and report what needs hand-finishing')
    .option('--dry-run', 'report what would be written without writing anything')
    .action(async (flags: { dryRun?: boolean }) => { process.exitCode = await runMigrate(flags); });

  return program;
}

export async function runLs(opts: RunOpts = {}): Promise<void> {
  const log = opts.log ?? console.log;
  await refreshRegistry();
  log(body(doList({})));
}

export async function runInspect(name: string, opts: RunOpts = {}): Promise<number> {
  const log = opts.log ?? console.log;
  const errLog = opts.errLog ?? console.error;
  await refreshRegistry();
  const res = doInspect({ name });
  if (res.isError) { errLog(body(res)); return 1; }
  log(body(res));
  return 0;
}

export async function runValidate(name: string | undefined, opts: RunOpts = {}): Promise<number> {
  const log = opts.log ?? console.log;
  const errLog = opts.errLog ?? console.error;
  await refreshRegistry();
  const res = doValidate(name ? { name } : {});
  (res.isError ? errLog : log)(body(res));
  return res.isError ? 1 : 0;
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

/**
 * `run` is the ONE playbook subcommand that shells out. It reaches
 * playbooks/runner.ts and therefore the ConnectionManager, the daemon and
 * tools/ — including tools/screenshot.ts, the tree's only `sharp` importer.
 * Compiling it in would reinstate the per-platform native-addon build matrix
 * that item 26's shape removed. Accepted cost: an npx cold start per run.
 *
 * The terminal path deliberately ignores `security.playbook_eval`; that gate
 * exists because an AGENT is an untrusted caller. The child inherits this
 * process's real stdio, so its output is unmediated.
 *
 * The name/validity/param pre-flight stays on this side: it is compiled in and
 * costs nothing, so a typo or a blocked script fails here instead of after an
 * npx cold start. The `--param` flags are then forwarded exactly as typed —
 * the child re-parses them against the same meta.
 */
export async function runRun(
  name: string,
  flags: { param?: string[]; profile?: string; json?: boolean },
  opts: RunOpts = {},
): Promise<number> {
  const errLog = opts.errLog ?? console.error;

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

  const args = ['playbook', 'run', normalized];
  for (const pair of flags.param ?? []) args.push('--param', pair);
  if (flags.profile) args.push('--profile', flags.profile);
  if (flags.json) args.push('--json');

  return shellOut('supersurf-mcp', args);
}

export async function runPlaybookProgram(argv: string[]): Promise<void> {
  const program = buildPlaybookProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    console.error(`[playbook] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (require.main === module) {
  runPlaybookProgram(process.argv).catch(() => {
    // error already printed in runPlaybookProgram
  });
}
