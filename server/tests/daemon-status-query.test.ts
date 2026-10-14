import net from 'net';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { describe, it, expect } from 'vitest';
import { queryDaemonStatus } from '../src/daemon-spawn';

describe('queryDaemonStatus', () => {
  it('returns the daemon_status line', async () => {
    const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-')), 'd.sock');
    const srv = net.createServer(s => s.on('data', () => s.write(JSON.stringify({ type: 'daemon_status', version: '9.9.9', sessions: [{ sessionId: 'x' }] }) + '\n')));
    await new Promise<void>(r => srv.listen(sock, r));
    try {
      expect(await queryDaemonStatus(sock)).toMatchObject({ version: '9.9.9' });
    } finally {
      srv.close();
    }
  });

  it('returns null when no daemon listens', async () => {
    expect(await queryDaemonStatus('/nonexistent/d.sock')).toBeNull();
  });
});
