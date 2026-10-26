#!/usr/bin/env npx tsx
/**
 * Bundle shared/ into a package's dist/ for npm publish.
 *
 * Copies `shared/dist/` into `<pkg>/dist/shared/` and rewrites all
 * require("shared") / require("shared/...") imports to relative paths.
 *
 * Usage:
 *   npx tsx scripts/bundle-shared.ts server
 *   npx tsx scripts/bundle-shared.ts daemon
 *
 * Designed to be generic — works regardless of what modules exist in shared/.
 * Run this as part of prepublishOnly in each consuming package.
 */

import fs from 'fs';
import path from 'path';
import { hasLiveSource } from './shared-live';

const root = path.resolve(__dirname, '..');
const pkg = process.argv[2];

if (!pkg) {
  console.error('Usage: bundle-shared.ts <package-name>');
  console.error('  e.g. bundle-shared.ts server');
  process.exit(1);
}

const pkgDist = path.join(root, pkg, 'dist');
const sharedDist = path.join(root, 'shared', 'dist');
const targetDir = path.join(pkgDist, 'shared');

if (!fs.existsSync(pkgDist)) {
  console.error(`${pkg}/dist/ does not exist — build first`);
  process.exit(1);
}

if (!fs.existsSync(sharedDist)) {
  console.error('shared/dist/ does not exist — build shared first');
  process.exit(1);
}

// ── Step 1: Copy shared/dist/ → <pkg>/dist/shared/ ──────────

// Only files with a live source in shared/ are copied: shared/dist is never cleaned
// (live dev sessions run from it), so it can hold output of deleted sources.
function copyDir(src: string, dest: string): number {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      count += copyDir(srcPath, destPath);
    } else if (!hasLiveSource(path.relative(sharedDist, srcPath), path.join(root, 'shared'))) {
      console.log(`  Skipped stale shared/dist/${path.relative(sharedDist, srcPath)} (no live source)`);
    } else {
      fs.copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}

// Clean previous bundle
if (fs.existsSync(targetDir)) {
  fs.rmSync(targetDir, { recursive: true });
}

const filesCopied = copyDir(sharedDist, targetDir);
console.log(`  Copied ${filesCopied} file(s) → ${pkg}/dist/shared/`);

// ── Step 2: Rewrite require("shared") imports ────────────────

/**
 * Rewrite require("shared") and require("shared/...") to relative paths.
 *
 * For a file at <pkg>/dist/foo/bar.js, require("shared") becomes
 * require("../../shared") — computed from the file's depth relative to dist/.
 */
function rewriteFile(filePath: string): boolean {
  const content = fs.readFileSync(filePath, 'utf8');

  const requirePattern = /require\(["']shared(\/[^"']*)?["']\)/g;

  if (!requirePattern.test(content)) return false;

  // Compute relative path from this file to dist/shared/
  const relFromDist = path.relative(path.dirname(filePath), path.join(pkgDist, 'shared'));
  // Ensure forward slashes and ./ prefix
  const relPrefix = relFromDist.split(path.sep).join('/');
  const prefix = relPrefix.startsWith('.') ? relPrefix : './' + relPrefix;

  const rewritten = content.replace(
    /require\(["']shared(\/[^"']*)?["']\)/g,
    (_match, subpath) => {
      if (subpath) {
        return `require("${prefix}${subpath}")`;
      }
      return `require("${prefix}")`;
    },
  );

  fs.writeFileSync(filePath, rewritten, 'utf8');
  return true;
}

function rewriteDir(dir: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Don't rewrite inside the copied shared/ dir itself
      if (fullPath === targetDir) continue;
      count += rewriteDir(fullPath);
    } else if (entry.name.endsWith('.js')) {
      if (rewriteFile(fullPath)) count++;
    }
  }
  return count;
}

const filesRewritten = rewriteDir(pkgDist);
console.log(`  Rewrote ${filesRewritten} file(s) in ${pkg}/dist/`);

console.log(`  Done — ${pkg} is ready for publish`);
