import { spawnSync } from 'child_process';

/** The first Go toolchain that answers `version`: `GO`, the owner's install, then PATH. */
export function findGo(candidates: (string | undefined)[] = [process.env.GO, '/home/claudebox/.local/go/bin/go', 'go']): string | null {
  for (const g of candidates) {
    if (g && spawnSync(g, ['version'], { stdio: 'ignore' }).status === 0) return g;
  }
  return null;
}
