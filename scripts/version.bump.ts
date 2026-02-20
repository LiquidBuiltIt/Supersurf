#!/usr/bin/env npx tsx
/**
 * Release prep script. Bumps version across the monorepo, commits, and tags.
 *
 * Usage:
 *   npm run version.bump patch   # 0.6.2 -> 0.6.3
 *   npm run version.bump minor   # 0.6.2 -> 0.7.0
 *   npm run version.bump major   # 0.6.2 -> 1.0.0
 *   npm run version.bump rollback # undo last bump (reset commit + delete tag)
 *
 * After running, review the commit then push manually:
 *   git push && git push --tags
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

if (!bumpType || !['patch', 'minor', 'major', 'rollback'].includes(bumpType)) {
  console.error('Usage: npm run version.bump <patch|minor|major|rollback>');
  process.exit(1);
}

const targets = [
  'package.json',
  'server/package.json',
  'extension/package.json',
  'extension/manifest.json',
];

// ── Rollback ──────────────────────────────────────────────────

if (bumpType === 'rollback') {
  const lastMsg = gitCapture('git log --oneline -1 --format=%s');
  const versionMatch = lastMsg.match(/^v(\d+\.\d+\.\d+)$/);

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

  try { git(`git tag -d ${tag}`); } catch { /* tag may not exist */ }
  git('git reset --soft HEAD~1');

  console.log(`\n${green}Rolled back ${tag}${reset}`);
  console.log(`  Commit removed (changes preserved in staging)`);
  console.log(`  Tag ${tag} deleted\n`);
  console.log(`${yellow}Unstage version files if you don't want them:${reset}`);
  console.log(`  ${cyan}git restore --staged ${targets.join(' ')}${reset}\n`);
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

// Commit and tag — only stage version files, not everything
git(`git add ${targets.join(' ')}`);
git(`git commit -m "v${next}"`);
git(`git tag v${next}`);

console.log(`\n${green}Tagged v${next}${reset}`);
console.log(`${yellow}Review the commit before pushing to remotes.${reset}\n`);
console.log(`  ${cyan}git log --oneline -1${reset}    # check the commit`);
console.log(`  ${cyan}git push && git push --tags${reset}\n`);
