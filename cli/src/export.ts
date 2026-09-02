#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Absolute path to the per-session log directory under ~/.supersurf. */
export function getSessionsDir(homedir: string = os.homedir()): string {
  return path.join(homedir, '.supersurf', 'logs', 'sessions');
}

/**
 * Collect exactly the files /usage-data-audit consumes: the current
 * `metrics-*.ndjson` trail and the legacy `audit-*.ndjson` trail. Returns
 * sorted absolute paths; an empty array if the directory is missing/unreadable.
 */
export function findUsageLogs(sessionsDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(sessionsDir);
  } catch {
    return [];
  }
  return names
    .filter(
      (n) =>
        (n.startsWith('metrics-') || n.startsWith('audit-')) &&
        n.endsWith('.ndjson'),
    )
    .sort()
    .map((n) => path.join(sessionsDir, n));
}

/** Filesystem-safe, timestamped archive name. */
export function buildOutputName(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `supersurf-usage-logs-${stamp}.zip`;
}

export interface ExportDeps {
  sessionsDir?: string;
  cwd?: string;
  now?: Date;
  zip?: (outPath: string, files: string[]) => void;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
}

/** Default archiver: shell to the OS-native `zip` CLI, junking directory paths. */
function defaultZip(outPath: string, files: string[]): void {
  // -j junks paths (store bare filenames), -q quiet. Errors surface as a thrown
  // Error whose `.code` is 'ENOENT' when the `zip` binary is not on PATH.
  execFileSync('zip', ['-j', '-q', outPath, ...files], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

/**
 * `supersurf export` — bundle usage-metrics logs into a .zip in the caller's
 * cwd. Takes no flags; `argv` is accepted only for dispatcher-signature parity.
 * Returns a process exit code (0 = success, 1 = failure).
 */
export async function runExportProgram(
  _argv: string[],
  deps: ExportDeps = {},
): Promise<number> {
  const sessionsDir = deps.sessionsDir ?? getSessionsDir();
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? new Date();
  const zip = deps.zip ?? defaultZip;
  const out = deps.stdout ?? ((m: string) => process.stdout.write(m));
  const err = deps.stderr ?? ((m: string) => process.stderr.write(m));

  const files = findUsageLogs(sessionsDir);
  if (files.length === 0) {
    err(`[export] No usage-metrics logs found in ${sessionsDir}\n`);
    err(
      `[export] Nothing to export — enable logging.usage_metrics in ` +
        `~/.supersurf/config.json and run a session first.\n`,
    );
    return 1;
  }

  const outPath = path.join(cwd, buildOutputName(now));
  try {
    zip(outPath, files);
  } catch (e: any) {
    if (e && e.code === 'ENOENT') {
      err(
        `[export] The 'zip' CLI was not found on PATH. Install it ` +
          `(e.g. 'sudo apt install zip' or 'brew install zip') and retry.\n`,
      );
    } else {
      err(`[export] Failed to create archive: ${e?.message ?? String(e)}\n`);
    }
    return 1;
  }

  out(`[export] Bundled ${files.length} usage-log file(s) into ${outPath}\n`);
  return 0;
}

if (require.main === module) {
  runExportProgram(process.argv).then((code) => process.exit(code));
}
