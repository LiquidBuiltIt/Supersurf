/** `npm run test.shim`: `go vet` then `go test` in shim/. Skips (exit 0) when Go is not installed. */
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { findGo } from './find-go';

export function runTestShim(go: string | null): number {
  if (!go) {
    console.log('test.shim skipped: no go toolchain');
    return 0;
  }
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'shim');
  for (const args of [['vet', './...'], ['test', './...']]) {
    const r = spawnSync(go, args, { cwd, stdio: 'inherit', env: { ...process.env, GOTOOLCHAIN: 'local' } });
    if (r.status !== 0) return r.status ?? 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(runTestShim(findGo()));
