/**
 * `npm run build.shim.all`: build the four release binaries of the Go shim into
 * `server/bin/<goos>-<goarch>/supersurf-shim` (shipped inside the `supersurf-mcp` npm package).
 * `--check` only verifies what is already there (used by `prepublishOnly` and publish).
 * `npm run build` never runs this; the dev-only `build.shim` stays host-only.
 */
import path from 'path';
import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { findGo } from './find-go';

export const SHIM_TARGETS = [
  { goos: 'linux', goarch: 'amd64' },
  { goos: 'linux', goarch: 'arm64' },
  { goos: 'darwin', goarch: 'amd64' },
  { goos: 'darwin', goarch: 'arm64' },
];

// A stripped static Go binary of this shim is a few MB; the cap catches a build gone wrong, not growth.
export const MIN_SHIM_BYTES = 1024;
export const MAX_SHIM_BYTES = 20 * 1024 * 1024;

export type GoRun = (go: string, args: string[], opts: { cwd: string; env: Record<string, string | undefined> }) => number;

const defaultRun: GoRun = (go, args, opts) => spawnSync(go, args, { ...opts, stdio: 'inherit' }).status ?? 1;

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultServerDir = path.resolve(here, '..', 'server');
// Go source in <server>/shim; binaries in <server>/bin, so they ship in the supersurf-mcp package.
const binPath = (serverDir: string, t: { goos: string; goarch: string }) => path.join(serverDir, 'bin', `${t.goos}-${t.goarch}`, 'supersurf-shim');

/** Build all four targets; returns the output paths. Throws naming the target that failed. */
export function buildShimAll(o: { go: string; version: string; serverDir?: string; run?: GoRun }): string[] {
  const serverDir = o.serverDir ?? defaultServerDir;
  const run = o.run ?? defaultRun;
  // Start clean so a binary for a target we no longer build cannot ship.
  rmSync(path.join(serverDir, 'bin'), { recursive: true, force: true });
  return SHIM_TARGETS.map((t) => {
    const out = binPath(serverDir, t);
    mkdirSync(path.dirname(out), { recursive: true });
    const args = ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${o.version}`, '-o', out, '.'];
    const env = { ...process.env, CGO_ENABLED: '0', GOOS: t.goos, GOARCH: t.goarch, GOTOOLCHAIN: 'local' };
    if (run(o.go, args, { cwd: path.join(serverDir, 'shim'), env }) !== 0) throw new Error(`go build failed for ${t.goos}-${t.goarch}`);
    chmodSync(out, 0o755);
    return out;
  });
}

/** Every target present, mode 0755, and between MIN and MAX bytes. Throws listing every problem. */
export function checkShimBinaries(serverDir: string = defaultServerDir): void {
  const problems: string[] = [];
  for (const t of SHIM_TARGETS) {
    const name = `${t.goos}-${t.goarch}`;
    let st;
    try {
      st = statSync(binPath(serverDir, t));
    } catch {
      problems.push(`${name}: missing`);
      continue;
    }
    if (st.size < MIN_SHIM_BYTES) problems.push(`${name}: empty or too small (${st.size} bytes)`);
    else if (st.size > MAX_SHIM_BYTES) problems.push(`${name}: too large (${st.size} bytes, cap ${MAX_SHIM_BYTES})`);
    if ((st.mode & 0o777) !== 0o755) problems.push(`${name}: mode is not 0755`);
  }
  if (problems.length) throw new Error(`shim binaries not ready:\n  ${problems.join('\n  ')}`);
}

/** The shim version is the supersurf-mcp version. */
export const shimVersion = (serverDir: string = defaultServerDir): string =>
  JSON.parse(readFileSync(path.join(serverDir, 'package.json'), 'utf8')).version;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv.includes('--check')) {
      const go = findGo();
      if (!go) throw new Error('no go toolchain found (set GO, or install Go)');
      for (const o of buildShimAll({ go, version: shimVersion() })) console.log(`built ${path.relative(process.cwd(), o)} (${statSync(o).size} bytes)`);
    }
    checkShimBinaries();
    console.log('shim binaries ok');
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
