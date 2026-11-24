/**
 * The npm half of `publish.ts`, split out so tests can import it (publish.ts runs
 * its pipeline at module top level). Nothing here touches the network on its own:
 * every command goes through an injected function.
 */
import { resolve } from 'path';
import { execSync } from 'child_process';
import { buildShimAll, checkShimBinaries, shimVersion, type GoRun } from './shim-build';
import { findGo } from './find-go';

/** Publish order is dependency order: the server pins the daemon. The shim binaries ship inside the server package. */
export const NPM_PACKAGES = [
  { dir: 'daemon', name: 'supersurf-daemon' },
  { dir: 'server', name: 'supersurf-mcp' },
];

/** `npm publish` in each package directory, in order; the first failure throws and later packages are not published. */
export function publishNpmPackages(
  root: string,
  exec: (cmd: string, cwd: string) => void = (cmd, cwd) => void execSync(cmd, { cwd, stdio: 'inherit' }),
  onPublished: (name: string) => void = () => {},
): void {
  for (const p of NPM_PACKAGES) {
    exec('npm publish', resolve(root, p.dir));
    onPublished(p.name);
  }
}

/**
 * Is `name@version` on the registry? Only a genuine 404 counts as unpublished: no network,
 * a registry outage or an auth error also exit non-zero and must not read as "not published".
 */
export function npmPublishState(
  name: string,
  version: string,
  view: (cmd: string) => void = (cmd) => void execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }),
): 'published' | 'unpublished' {
  try {
    view(`npm view ${name}@${version} version`);
    return 'published';
  } catch (err: any) {
    const out = String(err?.stderr ?? '') + String(err?.stdout ?? '');
    if (/E404|No match found for version/.test(out)) return 'unpublished';
    throw new Error(out.trim() || String(err?.message ?? err));
  }
}

/** Build and check the four shim binaries. Always runs: there is no legacy-only skip. */
export function prepareShimBinaries(o: { go?: string | null; version?: string; serverDir?: string; run?: GoRun } = {}): string[] {
  const go = 'go' in o ? o.go : findGo();
  if (!go) throw new Error('no go toolchain found (set GO, or install Go): the release always builds the shim binaries');
  const outs = buildShimAll({ go, version: o.version ?? shimVersion(o.serverDir), serverDir: o.serverDir, run: o.run });
  checkShimBinaries(o.serverDir);
  return outs;
}
