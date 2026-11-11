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
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const root = resolve(__dirname, '..');
const serverDir = join(root, 'server');

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const work = mkdtempSync(join(tmpdir(), 'supersurf-smoke-'));
try {
  console.log('→ Building shared + engine + daemon + server...');
  run('npm run build.shared', root);
  run('npm run build.engine', root);
  run('npm run build', join(root, 'daemon'));
  run('npm run build', serverDir);

  console.log('→ Packing supersurf-daemon and supersurf-mcp...');
  run('npm pack --pack-destination ' + work, join(root, 'daemon'));
  run('npm pack --pack-destination ' + work, serverDir);
  const tarballs = readdirSync(work).filter((f) => f.endsWith('.tgz'));
  const daemonTgz = tarballs.find((f) => f.startsWith('supersurf-daemon-'));
  const serverTgz = tarballs.find((f) => f.startsWith('supersurf-mcp-'));
  if (!daemonTgz || !serverTgz) throw new Error(`npm pack produced ${tarballs.join(', ')}`);

  console.log('→ Installing both into a clean dir...');
  run('npm init -y', work);
  // The server pins supersurf-daemon exactly; point that pin at the local tarball.
  // npm rejects an override that differs from a direct dependency's spec (EOVERRIDE), so
  // declare both tarballs as direct deps and have the override reference that spec.
  run(`npm pkg set dependencies.supersurf-daemon=file:${daemonTgz} dependencies.supersurf-mcp=file:${serverTgz} 'overrides.supersurf-daemon=$supersurf-daemon'`, work);
  run('npm install', work);

  const pkgRoot = join(work, 'node_modules', 'supersurf-mcp', 'dist');
  console.log('→ Loading entrypoints (VITEST=1)...');
  // Throws if a require is unresolvable in the clean install. The daemon is a
  // SEPARATE package (supersurf-daemon) now — not bundled into the server.
  //
  // dist/cli.js parses process.argv at import time, so require()ing it boots
  // the MCP server. stdin is pinned to 'ignore' (not 'inherit'): the server's
  // exit watchdog shuts down on stdin close, and inheriting a live stdin — a
  // TTY when a human runs this — would leave the server sitting there forever.
  execSync(
    `node -e "process.env.VITEST='1'; require('${join(pkgRoot, 'cli.js')}'); console.log('modules-ok')"`,
    { env: { ...process.env, VITEST: '1' }, stdio: ['ignore', 'inherit', 'inherit'] },
  );

  console.log('→ Loading the engine through the server loader...');
  execSync(
    `node -e "const e = require('${join(pkgRoot, 'engine-loader.js')}').loadEngine(); if (typeof e.AgentSessionManager !== 'function') process.exit(1); console.log('engine-ok')"`,
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (existsSync(join(pkgRoot, 'engine'))) {
    throw new Error('supersurf-mcp tarball ships an engine copy; P1 allows the daemon package only');
  }

  // Item 28's headline acceptance criterion: the CLI left this package. A
  // stray bin here would put `supersurf` back on PATH from an npm install and
  // shadow the standalone `supersurf` binary built from cli/. NOTE: that
  // binary has no distribution channel yet -- `npm run build` does not run
  // build.cli and `npm run publish` does not upload it (BACKLOG item 28).
  const installed = JSON.parse(
    readFileSync(join(work, 'node_modules', 'supersurf-mcp', 'package.json'), 'utf8'),
  );
  if (installed.bin.supersurf || installed.bin['supersurf-daemon']) {
    throw new Error(
      `supersurf-mcp tarball still declares a stray bin: ${Object.keys(installed.bin).join(', ')}`,
    );
  }
  if (existsSync(join(pkgRoot, 'bin'))) {
    throw new Error('supersurf-mcp tarball still ships dist/bin/ — the CLI leaked back in');
  }

  console.log('\n✓ Smoke test passed — supersurf-mcp loads standalone.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
