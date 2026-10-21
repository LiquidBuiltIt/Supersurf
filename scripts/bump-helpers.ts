/**
 * Release-commit helpers for `version.bump.ts`, split out because that file
 * runs its CLI at module top level (same pattern as `changelog-cut.ts`).
 */

import { execFileSync } from 'child_process';

export const VERSION_TARGETS = [
  'package.json',
  'server/package.json',
  'extension/package.json',
  'extension/manifest.json',
  'daemon/package.json',
  'shared/package.json',
  'cli/package.json',
];

export const EXTENSION_CHANGELOG_JSON = 'extension/dist/pages/changelog.json';

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A release must start from a clean tree on `main`. `force` skips only the branch check. */
export function assertCleanMain(cwd: string, opts: { force?: boolean } = {}): void {
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!opts.force && branch !== 'main') {
    throw new Error(`Release bumps run on main, but the current branch is "${branch}". Pass --force to skip the branch check.`);
  }
  const dirty = git(cwd, ['status', '--porcelain']);
  if (dirty) {
    throw new Error(`Working tree is not clean — commit or stash first:\n${dirty}`);
  }
}

/** Exactly the files a release commit may contain. Never `.`. */
export function stagedPaths(blogPath: string | null): string[] {
  return [...VERSION_TARGETS, 'CHANGELOG.md', EXTENSION_CHANGELOG_JSON, ...(blogPath ? [blogPath] : [])];
}

/** Stage `paths` and commit with `message` passed as one argv entry (no shell). */
export function commitRelease(cwd: string, paths: string[], message: string, stdio: 'inherit' | 'pipe' = 'inherit'): void {
  execFileSync('git', ['add', '--', ...paths], { cwd });
  execFileSync('git', ['commit', '-m', message], { cwd, stdio });
}
