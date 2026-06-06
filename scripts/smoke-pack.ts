#!/usr/bin/env npx tsx
/**
 * Self-containment smoke test for the published `supersurf` package.
 *
 * Packs the server package, installs the tarball into a throwaway temp dir
 * (no workspace symlinks), and require()s the bundled entrypoints. If any
 * bundled module (daemon main, shared, ws) is missing from the tarball or
 * its deps, the require throws and this script exits non-zero.
 *
 * VITEST=1 is set so the daemon's entry guard does NOT auto-start a daemon
 * (it would write to the real ~/.supersurf/ and collide with live sessions).
 *
 * Usage: npm run smoke.pack
 * Requires network (npm install of the tarball's runtime deps).
 */
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const root = resolve(__dirname, '..');
const serverDir = join(root, 'server');

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const work = mkdtempSync(join(tmpdir(), 'supersurf-smoke-'));
try {
  console.log('→ Building server (shared bundle only, daemon is separate)...');
  run('npm run build', serverDir);

  console.log('→ Packing supersurf...');
  run('npm pack --pack-destination ' + work, serverDir);
  const tarball = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack produced no .tgz');

  console.log(`→ Installing ${tarball} into a clean dir...`);
  run('npm init -y', work);
  run(`npm install ./${tarball}`, work);

  const pkgRoot = join(work, 'node_modules', 'supersurf-mcp', 'dist');
  console.log('→ Loading entrypoints (VITEST=1)...');
  // Throws if a require is unresolvable in the clean install. The daemon is a
  // SEPARATE package (supersurf-daemon) now — not bundled into the server.
  execSync(
    `node -e "process.env.VITEST='1'; require('${join(pkgRoot, 'bin', 'dispatcher.js')}'); console.log('modules-ok')"`,
    { env: { ...process.env, VITEST: '1' }, stdio: 'inherit' },
  );

  console.log('\n✓ Smoke test passed — supersurf-mcp loads standalone.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
