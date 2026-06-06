#!/usr/bin/env npx tsx
/**
 * Bundle daemon/dist/ into server/dist/daemon/ for npm publish.
 *
 * Mirror of scripts/shared.bundle.ts's copy step. No import rewriting
 * needed here — daemon's internal imports are relative; any
 * `require("shared")` calls inside daemon files get rewritten when
 * scripts/shared.bundle.ts runs afterward (it walks all .js files in
 * server/dist/ including the newly-copied daemon/ subtree).
 *
 * Usage:
 *   npx tsx scripts/daemon.bundle.ts
 */

import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const daemonDist = path.join(root, 'daemon', 'dist');
const targetDir = path.join(root, 'server', 'dist', 'daemon');

if (!fs.existsSync(daemonDist)) {
  console.error('daemon/dist/ does not exist — build daemon first');
  process.exit(1);
}

function copyDir(src: string, dest: string): number {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      count += copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}

if (fs.existsSync(targetDir)) {
  fs.rmSync(targetDir, { recursive: true });
}

const filesCopied = copyDir(daemonDist, targetDir);
console.log(`  Copied ${filesCopied} file(s) → server/dist/daemon/`);
console.log(`  Done — daemon bundled into server`);
