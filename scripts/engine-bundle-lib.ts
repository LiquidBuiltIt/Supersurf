import fs from 'fs';
import path from 'path';
import { hasLiveSource } from './shared-live';

/**
 * Copy `engine/dist` into `daemon/dist/engine`. Only files with a live source in
 * `engine/src` are copied (engine/dist is never cleaned, so it can hold output of
 * deleted sources). No `package.json` is copied: the sandbox read roots are the
 * nearest `package.json` up from `child.js`, which must be the daemon's.
 * Returns the number of files copied.
 */
export function bundleEngine(root: string): number {
  const engineDist = path.join(root, 'engine', 'dist');
  const engineSrc = path.join(root, 'engine', 'src');
  const target = path.join(root, 'daemon', 'dist', 'engine');

  if (!fs.existsSync(engineDist)) throw new Error('engine/dist/ does not exist: build engine first');
  fs.rmSync(target, { recursive: true, force: true });

  const copyDir = (src: string, dest: string): number => {
    fs.mkdirSync(dest, { recursive: true });
    let count = 0;
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const from = path.join(src, entry.name);
      const to = path.join(dest, entry.name);
      if (entry.isDirectory()) count += copyDir(from, to);
      else if (hasLiveSource(path.relative(engineDist, from), engineSrc)) {
        fs.copyFileSync(from, to);
        count++;
      }
    }
    return count;
  };
  return copyDir(engineDist, target);
}
