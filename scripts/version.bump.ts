#!/usr/bin/env npx tsx
/**
 * Release prep script. Bumps version across the monorepo and commits.
 *
 * Usage:
 *   npm run version.bump patch "fix port cleanup"  # v0.6.3 — fix port cleanup
 *   npm run version.bump minor "add profiles"      # v0.7.0 — add profiles
 *   npm run version.bump major "breaking changes"   # v1.0.0 — breaking changes
 *   npm run version.bump rollback # undo last bump (reset commit, restore version files)
 *
 * Tagging happens at publish time (`npm run publish`), not here. This means
 * tags only exist for versions that were actually shipped — re-bumping or
 * amending after this script is free, no tag cleanup needed.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import { execSync } from 'child_process';

// ANSI colors
const yellow = '\x1b[33m';
const green = '\x1b[32m';
const cyan = '\x1b[36m';
const red = '\x1b[31m';
const reset = '\x1b[0m';

const root = resolve(__dirname, '..');
const git = (cmd: string) => execSync(cmd, { cwd: root, stdio: 'inherit' });
const gitCapture = (cmd: string) => execSync(cmd, { cwd: root, encoding: 'utf8' }).trim();

const bumpType = process.argv[2] as 'patch' | 'minor' | 'major' | 'rollback';
const commitMsg = process.argv.slice(3).join(' ').trim() || '';

if (!bumpType || !['patch', 'minor', 'major', 'rollback'].includes(bumpType)) {
  console.error('Usage: npm run version.bump <patch|minor|major|rollback> <message>');
  process.exit(1);
}

if (bumpType !== 'rollback' && !commitMsg) {
  console.error(`${red}Commit message is required.${reset}`);
  console.error(`Usage: npm run version.bump ${bumpType} "your message here"`);
  process.exit(1);
}

const targets = [
  'package.json',
  'server/package.json',
  'extension/package.json',
  'extension/manifest.json',
  'daemon/package.json',
  'shared/package.json',
];

// ── Rollback ──────────────────────────────────────────────────

if (bumpType === 'rollback') {
  const lastMsg = gitCapture('git log --oneline -1 --format=%s');
  const versionMatch = lastMsg.match(/^v(\d+\.\d+\.\d+)/);

  if (!versionMatch) {
    console.error(`${red}Last commit is not a version bump: "${lastMsg}"${reset}`);
    console.error('Rollback only works on the most recent version.bump commit.');
    process.exit(1);
  }

  const tag = `v${versionMatch[1]}`;
  const pushed = gitCapture('git log --oneline origin/main..HEAD').length > 0;

  if (!pushed) {
    console.error(`${red}Last version commit appears to be pushed already. Rollback aborted.${reset}`);
    console.error('Use git revert instead for pushed commits.');
    process.exit(1);
  }

  // Tags are now created at publish time, but defensively clean up any legacy
  // or manually-created tag pointing at this commit.
  try { git(`git tag -d ${tag}`); } catch { /* tag may not exist */ }
  git('git reset --soft HEAD~1');

  // Restore version files to pre-bump state so the next bump reads the correct version
  for (const rel of targets) {
    git(`git checkout HEAD -- "${rel}"`);
  }

  const restoredVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  console.log(`\n${green}Rolled back ${tag} → v${restoredVersion}${reset}`);
  console.log(`  Commit removed (non-version changes preserved in staging)`);
  console.log(`  Tag ${tag} deleted`);
  console.log(`  Version files restored to v${restoredVersion}\n`);
  process.exit(0);
}

// ── Bump ──────────────────────────────────────────────────────

const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const current = rootPkg.version;

const [major, minor, patch] = current.split('.').map(Number);
const next =
  bumpType === 'major' ? `${major + 1}.0.0` :
  bumpType === 'minor' ? `${major}.${minor + 1}.0` :
  `${major}.${minor}.${patch + 1}`;

for (const rel of targets) {
  const file = join(root, rel);
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  pkg.version = next;
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  ${rel}: ${current} -> ${next}`);
}

console.log(`\nBumped ${bumpType}: ${current} -> ${next}\n`);

// Commit (no tag — tagging happens at publish time)
git(`git add .`);
const fullMsg = commitMsg ? `v${next} — ${commitMsg}` : `v${next}`;
git(`git commit -m "${fullMsg}"`);

console.log(`\n${green}Committed v${next}${reset}`);
console.log(`${yellow}Tag will be created when you publish. To ship:${reset}\n`);
console.log(`  ${cyan}git log --oneline -1${reset}    # review the commit`);
console.log(`  ${cyan}npm run publish${reset}         # tag, push, npm, CWS\n`);
