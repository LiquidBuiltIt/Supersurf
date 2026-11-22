#!/usr/bin/env npx tsx
/**
 * Self-containment smoke test for the published packages.
 *
 * Packs `supersurf-shim`, `supersurf-daemon` and `supersurf-mcp`, installs the
 * three tarballs together into a throwaway temp dir (no workspace symlinks),
 * require()s the entrypoints and loads the engine through `engine-loader.js`.
 * If any module is missing from a tarball or its deps, the require throws and
 * this script exits non-zero.
 *
 * Then, from the installed packages only: the host shim binary is 0755 and
 * prints its version, the tarball holds no Go source, `findShimBinary` finds
 * it from the daemon root, and with `agents.relay` on in a throwaway HOME the
 * installed `supersurf-mcp` bin becomes the shim, whose `ensure` installs
 * `versions/<v>/` and starts the daemon from there; that daemon answers
 * `initialize` and `tools/list` through the shim. Never port 5555, never the
 * real ~/.supersurf, no SUPERSURF_DEV_ENVIRONMENT / SUPERSURF_SHIM_BIN.
 *
 * VITEST=1 stops the daemon auto-start, and a throwaway HOME keeps the probes
 * off the real ~/.supersurf/ (booting cli.js would truncate its server.log).
 *
 * Usage: npm run smoke.pack
 * Requires network (npm install of the tarball's runtime deps).
 */
import { execSync, spawn, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, statSync, realpathSync, writeFileSync, readlinkSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { basename, join, resolve } from 'path';
import net from 'net';

const root = resolve(__dirname, '..');
const serverDir = join(root, 'server');

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const ok = (m: string) => console.log(`  ✓ ${m}`);
function assert(cond: unknown, message: string): asserts cond { if (!cond) throw new Error(message); }
const kb = (f: string) => `${Math.round(statSync(f).size / 1024)} KB`;
const freePort = () => new Promise<number>((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
});
const cmdline = (pid: number) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { return ''; } };

// Short names: HOME/.supersurf/daemon.sock must fit the 108-byte socket path limit.
const work = mkdtempSync(join(tmpdir(), 'ssp-'));
const smokeHome = mkdtempSync(join(tmpdir(), 'ssp-h-'));
let server: ReturnType<typeof spawn> | undefined;
async function main() {
try {
  console.log('→ Building shared + engine + daemon + server...');
  run('npm run build.shared', root);
  run('npm run build.engine', root);
  run('npm run build', join(root, 'daemon'));
  run('npm run build', serverDir);

  console.log('→ Building the four shim binaries...');
  run('npm run build.shim.all', root);

  console.log('→ Packing supersurf-shim, supersurf-daemon and supersurf-mcp...');
  run('npm pack --pack-destination ' + work, join(root, 'shim'));
  run('npm pack --pack-destination ' + work, join(root, 'daemon'));
  run('npm pack --pack-destination ' + work, serverDir);
  const tarballs = readdirSync(work).filter((f) => f.endsWith('.tgz'));
  const shimTgz = tarballs.find((f) => f.startsWith('supersurf-shim-'));
  const daemonTgz = tarballs.find((f) => f.startsWith('supersurf-daemon-'));
  const serverTgz = tarballs.find((f) => f.startsWith('supersurf-mcp-'));
  if (!shimTgz || !daemonTgz || !serverTgz) throw new Error(`npm pack produced ${tarballs.join(', ')}`);
  console.log(`  tarballs: ${[shimTgz, daemonTgz, serverTgz].map((t) => `${t} ${kb(join(work, t))}`).join(', ')}`);

  console.log('→ Installing all three into a clean dir...');
  run('npm init -y', work);
  // npm rejects an override that differs from a direct dependency's spec (EOVERRIDE), so
  // declare the tarballs as direct deps and have the overrides reference those specs. The
  // daemon pins supersurf-shim and the server pins supersurf-daemon at the exact (unpublished) version.
  run(`npm pkg set dependencies.supersurf-shim=file:${shimTgz} dependencies.supersurf-daemon=file:${daemonTgz} dependencies.supersurf-mcp=file:${serverTgz} 'overrides.supersurf-shim=$supersurf-shim' 'overrides.supersurf-daemon=$supersurf-daemon'`, work);
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
    { env: { ...process.env, VITEST: '1', HOME: smokeHome }, stdio: ['ignore', 'inherit', 'inherit'] },
  );

  console.log('→ Loading the engine through the server loader...');
  execSync(
    `node -e "const e = require('${join(pkgRoot, 'engine-loader.js')}').loadEngine(); if (typeof e.AgentSessionManager !== 'function') process.exit(1); console.log('engine-ok')"`,
    { env: { ...process.env, VITEST: '1', HOME: smokeHome }, stdio: ['ignore', 'inherit', 'inherit'] },
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

  // ---- the shim package ----
  const nm = join(work, 'node_modules');
  const shimVersion = JSON.parse(readFileSync(join(nm, 'supersurf-shim', 'package.json'), 'utf8')).version;
  const arch = ({ x64: 'amd64', arm64: 'arm64' } as Record<string, string>)[process.arch];
  assert(arch && (process.platform === 'linux' || process.platform === 'darwin'), `unsupported host ${process.platform}-${process.arch}`);
  const hostBin = join(nm, 'supersurf-shim', 'bin', `${process.platform}-${arch}`, 'supersurf-shim');
  console.log('→ Checking the installed supersurf-shim package...');
  // npm keeps the tarball's mode minus the umask, so an install under umask 002 is 0775: require at least 0755 here and exactly 0755 in the tarball.
  assert((statSync(hostBin).mode & 0o755) === 0o755, `${hostBin} is not at least mode 0755`);
  ok('installed host binary is executable (mode >= 0755)');
  const ver = spawnSync(hostBin, ['--version'], { encoding: 'utf8' });
  assert(ver.status === 0 && ver.stdout.includes(shimVersion), `--version printed ${JSON.stringify(ver.stdout)} (stderr ${ver.stderr}), want ${shimVersion}`);
  ok(`--version prints ${shimVersion}`);
  const listing = run(`tar tzf ${join(work, shimTgz)}`, work).split('\n').filter(Boolean);
  const badModes = run(`tar tvzf ${join(work, shimTgz)}`, work).split('\n').filter((l) => /\/supersurf-shim$/.test(l) && !l.startsWith('-rwxr-xr-x'));
  assert(badModes.length === 0, `shim tarball binaries not exactly 0755:\n${badModes.join('\n')}`);
  ok('all four binaries in the tarball are exactly mode 0755');
  const goFiles = listing.filter((f) => /\.go$|(^|\/)go\.(mod|sum)$/.test(f));
  assert(goFiles.length === 0, `shim tarball holds Go source: ${goFiles.join(', ')}`);
  ok(`tarball holds no Go source (${listing.length} files)`);

  // ---- findShimBinary from the installed server's daemon root ----
  console.log('→ findShimBinary from the installed daemon root...');
  const daemonPkgJson = createRequire(join(nm, 'supersurf-mcp', 'package.json')).resolve('supersurf-daemon/package.json');
  const daemonRoot = resolve(daemonPkgJson, '..');
  const daemonVersion = JSON.parse(readFileSync(daemonPkgJson, 'utf8')).version;
  // The installed supersurf-daemon bundles its own copy of shared (dist/shared); that is the code the server runs.
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env, HOME: smokeHome };
  for (const k of Object.keys(cleanEnv)) if (k.startsWith('SUPERSURF_')) delete cleanEnv[k];
  const found = execSync(
    `node -e "console.log(require('${join(daemonRoot, 'dist', 'shared', 'relay.js')}').findShimBinary('${daemonRoot}'))"`,
    { env: cleanEnv, encoding: 'utf8' },
  ).trim();
  assert(realpathSync(found) === realpathSync(hostBin), `findShimBinary returned ${found}, want ${hostBin}`);
  ok('findShimBinary (installed daemon/dist/shared/relay.js) returns the host binary');

  // ---- the installed bin becomes the shim; ensure installs versions/<v>/ and starts the daemon ----
  console.log('→ agents.relay on: installed supersurf-mcp -> shim -> daemon from versions/<v>/ (throwaway HOME)...');
  const ssDir = join(smokeHome, '.supersurf');
  mkdirSync(ssDir, { recursive: true });
  writeFileSync(join(ssDir, 'config.json'), JSON.stringify({ agents: { relay: true } }));
  const port = await freePort();
  assert(port !== 5555, 'free port is 5555');
  server = spawn(join(nm, '.bin', 'supersurf-mcp'), ['--port', String(port)], { cwd: smokeHome, env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  const mcp = server;
  mcp.stdin!.on('error', () => {});
  const lines: any[] = [];
  let buf = '', errOut = '';
  mcp.stdout!.on('data', (d) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) !== -1) {
      try { lines.push(JSON.parse(buf.slice(0, i))); } catch { /* not JSON */ }
      buf = buf.slice(i + 1);
    }
  });
  mcp.stderr!.on('data', (d) => { errOut += d; });
  const send = (o: unknown) => mcp.stdin!.write(JSON.stringify(o) + '\n');
  const reply = async (id: number, ms: number): Promise<any> => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) { const m = lines.find((l) => l.id === id); if (m) return m; }
    throw new Error(`no reply for id ${id} in ${ms} ms; mcp stderr: ${errOut.slice(-500)}`);
  };

  const exe = () => { try { return realpathSync(readlinkSync(`/proc/${mcp.pid}/exe`)); } catch { return ''; } };
  if (process.platform === 'linux') {
    for (let i = 0; i < 200 && basename(exe()) !== 'supersurf-shim'; i++) await sleep(25);
    assert(exe() === realpathSync(hostBin), `/proc/${mcp.pid}/exe is ${exe()}, want ${hostBin}`);
    ok(`pid ${mcp.pid} became the installed shim (same pid)`);
  }

  // The shim answers locally until its daemon is up; the first start installs versions/<v>/ (copies sharp etc.).
  const initMsg = { jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-pack', version: '0' } } };
  let init: any;
  for (let id = 100; id < 400; id++) {
    send({ ...initMsg, id });
    try { init = await reply(id, 2000); } catch { init = undefined; }
    if (init?.result?.serverInfo?.name === 'SuperSurf') break;
    await sleep(250);
  }
  assert(init?.result?.serverInfo?.name === 'SuperSurf', `engine never answered initialize; last: ${JSON.stringify(init)}; mcp stderr: ${errOut.slice(-500)}`);
  ok('initialize answered by the daemon-hosted engine');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const tools: any[] = (await reply(1, 15000)).result.tools;
  assert(tools.length > 0, 'tools/list is empty');
  ok(`tools/list returned ${tools.length} tools`);

  const versionDir = join(ssDir, 'daemon', 'versions', daemonVersion);
  assert(existsSync(join(versionDir, 'dist', 'main.js')), `${versionDir}/dist/main.js missing`);
  const entry = JSON.parse(readFileSync(join(ssDir, 'daemon', 'entry'), 'utf8'));
  assert(entry.main === join(versionDir, 'dist', 'main.js') && entry.version === daemonVersion, `entry is ${JSON.stringify(entry)}`);
  ok(`entry names versions/${daemonVersion}/dist/main.js`);
  const daemonPid = Number(readFileSync(join(ssDir, 'daemon.pid'), 'utf8').trim());
  assert(cmdline(daemonPid).includes(`versions/${daemonVersion}/dist/main.js`), `daemon cmdline is: ${cmdline(daemonPid)}`);
  ok(`daemon pid ${daemonPid} runs from versions/${daemonVersion}/dist/main.js`);
  console.log(`  versions/${daemonVersion}/ install size: ${run(`du -sh ${versionDir}`, work).split('\t')[0]}`);

  // ---- clean up by recorded pid (the daemon must be this HOME's) ----
  mcp.stdin!.end();
  mcp.kill('SIGKILL');
  assert(cmdline(daemonPid).includes(smokeHome), 'daemon pid is not this smoke HOME\'s; refusing to kill');
  process.kill(daemonPid, 'SIGTERM');
  for (let i = 0; i < 100 && alive(daemonPid); i++) await sleep(100);
  if (alive(daemonPid)) process.kill(daemonPid, 'SIGKILL');
  assert(!alive(daemonPid) && !alive(mcp.pid!), 'a started process is still alive');
  server = undefined;

  console.log('\n✓ Smoke test passed — the packed shim, daemon and server install together and run.');
} finally {
  if (server?.pid && alive(server.pid)) server.kill('SIGKILL');
  rmSync(work, { recursive: true, force: true });
  rmSync(smokeHome, { recursive: true, force: true });
}
}

main().catch((err) => { console.error(`\n✗ FAIL — ${err instanceof Error ? err.message : err}`); process.exit(1); });
