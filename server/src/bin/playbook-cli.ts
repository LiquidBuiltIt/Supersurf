#!/usr/bin/env node
/**
 * `supersurf playbook` — manage saved playbooks.
 *
 * File management (`ls`/`inspect`/`edit`/`rm`/`export`/`import`) is daemon-free
 * by design, modelled on `creds.ts` rather than `profiles-cli.ts`: it must
 * work with no daemon running and no browser connected. Creation is
 * deliberately absent — playbooks are built from action ids that live in the
 * agent's context, not in the user's terminal.
 *
 * `run` is the one command that needs a live browser: it drives the same
 * `ConnectionManager` the MCP server and `--script-mode` use (see
 * `stdio.ts`), in-process, so there is exactly one playbook runner — the
 * `playbooks` MCP tool — regardless of caller.
 *
 * @module bin/playbook-cli
 */

import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  listPlaybooks, loadPlaybook, savePlaybook, removePlaybook,
  playbookExists, normalizeName, getBaseDir,
} from '../playbooks/store';
import { formatSteps } from '../playbooks/format';
import type { Playbook } from '../playbooks/types';
import { ConnectionManager } from '../backend';
import { buildConfigService, backendConfigFrom } from '../backend-config';

const { version: PACKAGE_VERSION } = require('../../package.json');

/** Either a bare exit status (legacy shape), or a status/error pair mirroring `spawnSync`'s result. */
export type SpawnEditorResult = number | { status: number | null; error?: Error };

export interface RunOpts {
  log?: (msg: string) => void;
  spawnEditor?: (cmd: string, args: string[]) => SpawnEditorResult;
  isTTY?: boolean;
}

function defaultSpawnEditor(cmd: string, args: string[]): SpawnEditorResult {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  return { status: result.status, error: result.error };
}

export function buildPlaybookProgram(): Command {
  const program = new Command();
  program
    .name('supersurf playbook')
    .description('Manage saved SuperSurf playbooks');

  program
    .command('ls')
    .description('List saved playbooks')
    .action(async () => { await runLs(); });

  program
    .command('inspect')
    .description('Print a playbook\'s steps')
    .argument('<name>', 'playbook name')
    .action(async (name: string) => { await runInspect(name); });

  program
    .command('edit')
    .description('Open a playbook in $EDITOR, or drop a step with --drop')
    .argument('<name>', 'playbook name')
    .option('--drop <step>', 'step number to remove (1-based, as shown by `inspect`)')
    .action(async (name: string, opts: { drop?: string }) => { await runEdit(name, opts); });

  program
    .command('rm')
    .description('Remove a playbook')
    .argument('<name>', 'playbook name')
    .action(async (name: string) => { await runRm(name); });

  program
    .command('export')
    .description('Write a playbook to a file')
    .argument('<name>', 'playbook name')
    .argument('<file>', 'destination path')
    .action(async (name: string, file: string) => { await runExport(name, file); });

  program
    .command('import')
    .description('Read a playbook from a file')
    .argument('<file>', 'source path')
    .action(async (file: string) => { await runImport(file); });

  program
    .command('run')
    .description('Run a saved playbook against a connected browser (no MCP client needed)')
    .argument('<name>', 'playbook name')
    .option('--profile <profile>', 'managed browser profile to connect to')
    .option('--json', 'print machine-readable JSON instead of the run trail')
    .action(async (name: string, opts: { profile?: string; json?: boolean }) => {
      process.exitCode = await runRun(name, opts);
    });

  return program;
}

export async function runLs(opts: RunOpts = {}): Promise<void> {
  const log = opts.log ?? console.log;
  const all = listPlaybooks();
  if (all.length === 0) {
    log('(no playbooks saved)');
    return;
  }
  const nameWidth = Math.max(4, ...all.map(p => p.name.length));
  const header = `${'Name'.padEnd(nameWidth)}  Steps  Purpose`;
  log(header);
  log('-'.repeat(header.length));
  for (const p of all.sort((a, b) => a.name.localeCompare(b.name))) {
    log(`${p.name.padEnd(nameWidth)}  ${String(p.steps.length).padStart(5)}  ${p.purpose}`);
  }
}

export async function runInspect(name: string, opts: RunOpts = {}): Promise<void> {
  const log = opts.log ?? console.log;
  const pb = loadPlaybook(name);
  if (!pb) throw new Error(`No playbook named '${name}'`);
  log(formatSteps(pb));
}

export async function runEdit(
  name: string,
  flags: { drop?: string },
  opts: RunOpts = {},
): Promise<void> {
  const log = opts.log ?? console.log;

  if (flags.drop !== undefined) {
    const pb = loadPlaybook(name);
    if (!pb) throw new Error(`No playbook named '${name}'`);

    const n = Number(flags.drop);
    if (!Number.isInteger(n) || n < 1 || n > pb.steps.length) {
      throw new Error(`Step ${flags.drop} is out of range — '${name}' has ${pb.steps.length} steps`);
    }
    if (pb.steps.length === 1) {
      throw new Error(`'${name}' has only one step. Remove the playbook instead: supersurf playbook rm ${name}`);
    }

    const [dropped] = pb.steps.splice(n - 1, 1);
    savePlaybook(pb);
    log(`Dropped step ${n} (${dropped.type}) from '${pb.name}'. ${pb.steps.length} steps remain.`);
    return;
  }

  const normalized = normalizeName(name);
  const filePath = path.join(getBaseDir(), `${normalized}.json`);

  const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isTTY) {
    throw new Error(
      `No terminal attached. Pass --drop <step>, edit the file directly at ${filePath}, ` +
      'or run in an interactive shell to edit in $EDITOR.',
    );
  }

  const editorCmd = process.env.VISUAL || process.env.EDITOR;
  if (!editorCmd) {
    throw new Error(
      "No editor is configured. Set $EDITOR (or $VISUAL) to use 'playbook edit', " +
      `or edit the playbook file directly at ${filePath}, or use --drop <step>.`,
    );
  }

  const pb = loadPlaybook(name);
  if (!pb) throw new Error(`No playbook named '${name}'`);

  const original = JSON.stringify(pb, null, 2);
  const tmpPath = path.join(os.tmpdir(), `supersurf-playbook-${normalized}-${process.pid}.json`);
  fs.writeFileSync(tmpPath, original, { mode: 0o600 });

  const [cmd, ...editorArgs] = editorCmd.split(/\s+/).filter(Boolean);
  const spawnEditor = opts.spawnEditor ?? defaultSpawnEditor;
  const result = spawnEditor(cmd, [...editorArgs, tmpPath]);
  const { status, error } = typeof result === 'number' ? { status: result, error: undefined } : result;

  if (error) {
    fs.rmSync(tmpPath, { force: true });
    throw new Error(
      `Could not launch editor '${editorCmd}': ${error.message}. ` +
      `Edit the file directly at ${filePath}, or pass --drop <step>.`,
    );
  }
  if (status !== 0) {
    fs.rmSync(tmpPath, { force: true });
    throw new Error(`Editor exited with status ${status}; playbook unchanged.`);
  }

  const edited = fs.readFileSync(tmpPath, 'utf8');
  if (edited === original) {
    fs.rmSync(tmpPath, { force: true });
    log(`No changes to '${normalized}'.`);
    return;
  }

  let parsed: Playbook;
  try {
    parsed = JSON.parse(edited) as Playbook;
  } catch (err) {
    throw new Error(
      `Edited file is not valid JSON: ${err instanceof Error ? err.message : String(err)}. Your edit is kept at ${tmpPath}.`,
    );
  }
  if (
    !parsed || typeof parsed !== 'object' ||
    !Array.isArray(parsed.steps) || parsed.steps.length === 0 ||
    parsed.version !== 1
  ) {
    throw new Error(
      `Edited file is not a playbook (expected version 1 and a non-empty steps array). Your edit is kept at ${tmpPath}.`,
    );
  }

  if (typeof parsed.name === 'string' && normalizeName(parsed.name) !== normalized) {
    log(`Name is fixed to '${normalized}'; use export/import to rename.`);
  }
  parsed.name = normalized;

  savePlaybook(parsed);
  fs.rmSync(tmpPath, { force: true });
  log(`Saved '${normalized}' (${parsed.steps.length} steps).`);
}

export async function runRm(name: string, opts: RunOpts = {}): Promise<void> {
  const log = opts.log ?? console.log;
  if (!removePlaybook(name)) throw new Error(`No playbook named '${name}'`);
  log(`Removed playbook '${normalizeName(name)}'`);
}

export async function runExport(name: string, file: string, opts: RunOpts = {}): Promise<void> {
  const log = opts.log ?? console.log;
  const pb = loadPlaybook(name);
  if (!pb) throw new Error(`No playbook named '${name}'`);
  fs.writeFileSync(file, JSON.stringify(pb, null, 2), { mode: 0o600 });
  log(`Exported '${pb.name}' (${pb.steps.length} steps) to ${file}`);
}

export async function runImport(file: string, opts: RunOpts = {}): Promise<void> {
  const log = opts.log ?? console.log;
  let parsed: Playbook;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Playbook;
  } catch (err) {
    throw new Error(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed.name !== 'string' || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error(`${file} is not a playbook (expected a name and a non-empty steps array)`);
  }
  if (playbookExists(parsed.name)) {
    throw new Error(
      `A playbook named '${normalizeName(parsed.name)}' already exists. ` +
      `Remove it first: supersurf playbook rm ${normalizeName(parsed.name)}`,
    );
  }
  savePlaybook({ ...parsed, name: normalizeName(parsed.name), version: 1 });
  log(`Imported '${normalizeName(parsed.name)}' (${parsed.steps.length} steps)`);
}

/** Minimal surface `run` needs from a live connection — mirrors `ConnectionManager.callTool`. */
export interface RunBackend {
  callTool(name: string, args: Record<string, unknown>, options: { rawResult?: boolean }): Promise<any>;
}

export interface RunRunOpts {
  log?: (msg: string) => void;
  errLog?: (msg: string) => void;
  /** Test seam. Production builds a real `ConnectionManager` off resolved config. */
  createBackend?: () => RunBackend;
}

function defaultCreateBackend(): RunBackend {
  return new ConnectionManager(backendConfigFrom(buildConfigService({}), PACKAGE_VERSION));
}

/**
 * Run a saved playbook end-to-end: connect, call the `playbooks` MCP tool with
 * `{action:'run', name}`, print its result, then disconnect. Always disconnects —
 * on a failed step, a connect failure, an unexpected error, or SIGINT — because a
 * left-open session pins the daemon (and, for a managed profile, the browser) alive.
 *
 * Returns the process exit code rather than throwing, so a reported failed step
 * (not a bug — a normal "the playbook broke on step 3" outcome) prints its own
 * trail instead of being flattened into the generic `[playbook] <message>` shape
 * `runPlaybookProgram`'s catch-all uses for actual exceptions.
 */
export async function runRun(
  name: string,
  flags: { profile?: string; json?: boolean },
  opts: RunRunOpts = {},
): Promise<number> {
  const log = opts.log ?? console.log;
  const errLog = opts.errLog ?? console.error;

  const normalized = normalizeName(name);
  const pb = loadPlaybook(normalized);
  if (!pb) {
    errLog(`[playbook] No playbook named '${normalized}'. List them with: supersurf playbook ls`);
    return 1;
  }

  // Resolution order: --profile flag, then the playbook's own optional
  // `profile` field (a parallel branch is adding this to the schema — read
  // it defensively, don't assume the type declares it yet), then none.
  const profile = flags.profile ?? (typeof (pb as any).profile === 'string' ? (pb as any).profile : undefined);

  const backend = (opts.createBackend ?? defaultCreateBackend)();

  let disconnectStarted = false;
  const disconnect = async (): Promise<void> => {
    if (disconnectStarted) return;
    disconnectStarted = true;
    try {
      await backend.callTool('disconnect', {}, { rawResult: true });
    } catch {
      // Best-effort — we're already on our way out.
    }
  };

  const onSigint = (): void => {
    void disconnect().finally(() => process.exit(1));
  };
  process.once('SIGINT', onSigint);

  try {
    const connectArgs: Record<string, unknown> = { client_id: `playbook-run-${process.pid}` };
    if (profile) connectArgs.profile = profile;

    const connectResult: any = await backend.callTool('connect', connectArgs, { rawResult: true });
    if (!connectResult?.success) {
      errLog(`[playbook] Connect failed: ${connectResult?.message ?? 'unknown error'}`);
      return 1;
    }

    const runResult: any = await backend.callTool('playbooks', { action: 'run', name: normalized }, { rawResult: true });
    const body = String(runResult?.content?.find((b: any) => b?.type === 'text')?.text ?? '');
    const failed = Boolean(runResult?.isError);

    if (flags.json) {
      log(JSON.stringify({ name: normalized, success: !failed, output: body }));
    } else if (failed) {
      errLog(body);
    } else {
      log(body);
    }

    return failed ? 1 : 0;
  } catch (err: any) {
    errLog(`[playbook] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await disconnect();
    process.off('SIGINT', onSigint);
  }
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
