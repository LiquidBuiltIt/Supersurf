/**
 * Dev-environment router.
 *
 * `SUPERSURF_DEV_ENVIRONMENT=<repo root>` makes each component run a clone's
 * code instead of the code it shipped with. `null` means "use what you
 * shipped with": the var is unset, or the clone cannot serve this component.
 * The second case says why on stderr — never stdout, which `supersurf mcp`
 * owns as its JSON-RPC stream.
 *
 * @module dev-source
 */
import fs from 'fs';
import path from 'path';

export type DevComponent = 'server' | 'daemon' | 'extension';

const ENTRY: Record<DevComponent, string> = {
  server: 'server/dist/cli.js',
  daemon: 'daemon/dist/main.js',
  extension: 'extension',
};

function sameFile(a: string, b: string | undefined): boolean {
  try { return !!b && fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
}

export function devSource(component: DevComponent): string | null {
  const raw = process.env.SUPERSURF_DEV_ENVIRONMENT;
  if (!raw) return null;
  const root = path.resolve(raw);
  const target = path.join(root, ENTRY[component]);

  let problem: string | null = null;
  try {
    const name = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name;
    if (name !== 'supersurf') problem = `${root} is not a SuperSurf repo root (package.json name is "${name}")`;
  } catch {
    problem = `${root} is not a SuperSurf repo root (no readable package.json)`;
  }
  const probe = component === 'extension' ? path.join(target, 'manifest.json') : target;
  if (!problem && !fs.existsSync(probe)) {
    problem = `${path.relative(root, probe)} is missing. Run npm run build in ${root}`;
  }
  if (problem) {
    console.error(`[supersurf] SUPERSURF_DEV_ENVIRONMENT: ${problem}. Using the packaged ${component} instead.`);
    return null;
  }

  // The running entry already is the dev build; routing it again would loop.
  if (sameFile(target, process.argv[1])) return null;
  return target;
}
