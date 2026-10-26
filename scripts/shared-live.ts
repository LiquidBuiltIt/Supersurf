import fs from 'fs';
import path from 'path';

/**
 * True when a compiled file under shared/dist has a live source in shared/.
 * `foo.js`, `foo.d.ts`, `foo.js.map`, `foo.d.ts.map` all map to `foo.ts`; a
 * `.old` source (file or directory) is excluded from the build, so it never counts.
 * `rel` is relative to shared/dist, `sharedSrc` is the shared/ directory.
 * Split out because `shared.bundle.ts` runs its CLI at module top level.
 */
export function hasLiveSource(rel: string, sharedSrc: string): boolean {
  const base = rel.replace(/(\.d\.ts\.map|\.js\.map|\.d\.ts|\.js)$/, '');
  if (base === rel) return false;
  if (base.split(/[\\/]/).some((seg) => seg.endsWith('.old'))) return false;
  return fs.existsSync(path.join(sharedSrc, base + '.ts'));
}
