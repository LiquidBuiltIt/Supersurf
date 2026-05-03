#!/usr/bin/env npx tsx
/**
 * Print the project's TypeScript source tree, grouped by package.
 * Skips node_modules, dist, and tests.
 */

import { execSync } from 'child_process';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const PACKAGES = ['shared', 'daemon', 'server', 'extension'];

const C_BOLD = '\x1b[1m';
const C_DIM = '\x1b[2m';
const C_CYAN = '\x1b[36m';
const C_RESET = '\x1b[0m';

let grandTotal = 0;

for (const pkg of PACKAGES) {
  const cmd = `find ${pkg} -type f -name '*.ts' ! -path '*/node_modules/*' ! -path '*/dist/*' ! -path '*/tests/*' | sort`;
  const out = execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
  const files = out ? out.split('\n') : [];
  grandTotal += files.length;

  console.log(`\n${C_BOLD}${C_CYAN}━━ ${pkg} ${C_DIM}(${files.length} files)${C_RESET}`);
  for (const f of files) {
    console.log(`  ${f}`);
  }
}

console.log(`\n${C_DIM}${grandTotal} TypeScript files total${C_RESET}\n`);
