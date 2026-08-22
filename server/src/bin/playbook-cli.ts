#!/usr/bin/env node
/**
 * `supersurf playbook` — manage saved playbooks.
 *
 * Daemon-free by design, modelled on `creds.ts` rather than `profiles-cli.ts`:
 * this is pure file management, so it must work with no daemon running and no
 * browser connected. Creation is deliberately absent — playbooks are built from
 * action ids that live in the agent's context, not in the user's terminal.
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
  playbookExists, normalizeName,
} from '../playbooks/store';
import { formatSteps } from '../playbooks/format';
import type { Playbook } from '../playbooks/types';

export interface RunOpts {
  log?: (msg: string) => void;
  spawnEditor?: (cmd: string, args: string[]) => number;
  isTTY?: boolean;
}

function defaultSpawnEditor(cmd: string, args: string[]): number {
  return spawnSync(cmd, args, { stdio: 'inherit' }).status ?? 1;
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
    .command('show')
    .description('Print a playbook\'s steps')
    .argument('<name>', 'playbook name')
    .action(async (name: string) => { await runShow(name); });

  program
    .command('edit')
    .description('Open a playbook in $EDITOR, or drop a step with --drop')
    .argument('<name>', 'playbook name')
    .option('--drop <step>', 'step number to remove (1-based, as shown by `show`)')
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

export async function runShow(name: string, opts: RunOpts = {}): Promise<void> {
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

  const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isTTY) {
    throw new Error('No terminal attached. Pass --drop <step>, or run in an interactive shell to edit in $EDITOR.');
  }

  const pb = loadPlaybook(name);
  if (!pb) throw new Error(`No playbook named '${name}'`);
  const normalized = normalizeName(name);

  const original = JSON.stringify(pb, null, 2);
  const tmpPath = path.join(os.tmpdir(), `supersurf-playbook-${normalized}-${process.pid}.json`);
  fs.writeFileSync(tmpPath, original, { mode: 0o600 });

  const editorCmd = process.env.VISUAL || process.env.EDITOR || 'vi';
  const [cmd, ...editorArgs] = editorCmd.split(/\s+/).filter(Boolean);
  const spawnEditor = opts.spawnEditor ?? defaultSpawnEditor;
  const status = spawnEditor(cmd, [...editorArgs, tmpPath]);
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
