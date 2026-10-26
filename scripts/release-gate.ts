import net from 'net';
import { execFileSync, spawnSync } from 'child_process';
import { daemonCommand } from '../shared/commands';

// True when something already listens on host:port. Host matches the daemon's
// bind (daemon/src/extension-bridge.ts), so a held port is seen as the daemon sees it.
export function portInUse(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' ? resolve(true) : reject(e)));
    s.listen(port, host, () => s.close(() => resolve(false)));
  });
}

// Runs the full test suite as the release gate. `pretest` rebuilds the tracked
// `extension/dist/`, so a tree that differs after the run means the committed
// `extension/dist/` is not what would ship. Compared before/after (not "must
// be empty") so --no-github, which skips the clean-tree check, keeps working.
export async function runReleaseTests(
  cwd: string,
  opts: { cmd?: string[]; port?: number; stdio?: 'inherit' | 'pipe' } = {},
): Promise<void> {
  const { cmd = ['npm', 'test'], port = 5555, stdio = 'inherit' } = opts;
  if (await portInUse(port)) {
    throw new Error(`Port ${port} is in use. npm test needs it free. Stop the SuperSurf daemon first: ${daemonCommand('stop')}`);
  }
  const status = () => execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  const before = status();
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, stdio });
  const name = cmd.join(' ');
  if (r.status !== 0) {
    const why = r.error ? r.error.message : r.signal ? `signal ${r.signal}` : `exit ${r.status}`;
    throw new Error(`${name} failed (${why}). Nothing was pushed or published.`);
  }
  const after = status();
  if (after !== before) throw new Error(`${name} changed the working tree. The committed build output is stale:\n${after}`);
}
