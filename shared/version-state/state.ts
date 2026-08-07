import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { VersionState } from './types';

/** Default location of the version-state file: `~/.supersurf/version-state.json`. */
export function defaultVersionStatePath(): string {
  return path.join(os.homedir(), '.supersurf', 'version-state.json');
}

/** Extract the major component of a semver-ish `x.y.z` string, or null if unparsable. */
function parseMajor(version: string | null | undefined): number | null {
  if (typeof version !== 'string') return null;
  const m = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return parseInt(m[1], 10);
}

/**
 * True only when both versions parse as semver-ish `x.y.z` and the current
 * major is strictly greater than the last-recorded major. Same-major
 * minor/patch bumps, downgrades, and unparsable input are all false.
 */
export function shouldShowUpgradeNotice(lastVersion: string | null, currentVersion: string): boolean {
  const lastMajor = parseMajor(lastVersion);
  const currentMajor = parseMajor(currentVersion);
  if (lastMajor === null || currentMajor === null) return false;
  return currentMajor > lastMajor;
}

/** Best-effort read — any missing file, I/O error, or malformed JSON yields null. */
function readVersionState(filePath: string): VersionState | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    if (typeof parsed.last_version !== 'string') return null;
    return {
      last_version: parsed.last_version,
      last_used_at: typeof parsed.last_used_at === 'string' ? parsed.last_used_at : '',
    };
  } catch {
    return null;
  }
}

/** Best-effort write — swallows any I/O error rather than throwing. */
function writeVersionState(filePath: string, state: VersionState): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  } catch {
    // Best-effort — a failed write must never surface to the caller.
  }
}

export interface VersionCheckResult {
  shouldNotify: boolean;
}

/**
 * Read the version-state file, decide whether to show the major-version
 * upgrade notice, then record the current version + timestamp. Never
 * throws: any FS/parse error is treated as "no notice" (first-run behavior)
 * and the write is best-effort.
 */
export function checkAndTouchVersionState(
  currentVersion: string,
  filePath: string = defaultVersionStatePath(),
): VersionCheckResult {
  let shouldNotify = false;
  try {
    const state = readVersionState(filePath);
    shouldNotify = shouldShowUpgradeNotice(state ? state.last_version : null, currentVersion);
  } catch {
    shouldNotify = false;
  }

  writeVersionState(filePath, { last_version: currentVersion, last_used_at: new Date().toISOString() });

  return { shouldNotify };
}
