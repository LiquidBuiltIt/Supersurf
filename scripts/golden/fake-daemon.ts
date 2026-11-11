import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

export interface FakeDaemonOptions {
  /** Throwaway HOME. The socket lives at <home>/.supersurf/daemon.sock. */
  home: string;
  /** Version the fake daemon reports on `session_ack`. `null` = a pre-3.0 daemon that omits the field. */
  version: string | null;
  /** `activeSessionCount` on `session_ack`. `null` = omit (old daemon). */
  activeSessionCount: number | null;
  /** The version the server under test will report. Used only for the safety refusal below. */
  expectedVersion: string;
}

export interface FakeDaemon {
  /** Every JSON-RPC method name received, in order. */
  methods: string[];
  close(): Promise<void>;
}

const TAB = { id: 1, index: 0, url: 'about:blank', title: '', active: true };
/** Superset reply: works for tab create/list/select and for generic commands. */
const REPLY = { success: true, tabId: 1, id: 1, index: 0, url: TAB.url, title: '', active: true, currentTab: TAB, tabs: [TAB] };

export async function startFakeDaemon(opts: FakeDaemonOptions): Promise<FakeDaemon> {
  // A version mismatch with <= 1 session sends the server down the RESTART path:
  // real stopDaemon + real ensureDaemon (spawns a real daemon). Never allow that here.
  const mismatched = opts.version !== opts.expectedVersion;
  if (mismatched && (opts.activeSessionCount === null || opts.activeSessionCount <= 1)) {
    throw new Error('fake daemon refuses a configuration that would reach the restart path');
  }

  const dir = path.join(opts.home, '.supersurf');
  fs.mkdirSync(dir, { recursive: true });
  const sock = path.join(dir, 'daemon.sock');
  const methods: string[] = [];

  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.type === 'session_register') {
          const ack: Record<string, unknown> = { type: 'session_ack', browser: 'chrome', extensionConnected: true };
          if (opts.version !== null) ack.version = opts.version;
          if (opts.activeSessionCount !== null) ack.activeSessionCount = opts.activeSessionCount;
          conn.write(JSON.stringify(ack) + '\n');
        } else if (msg.jsonrpc === '2.0' && msg.id !== undefined) {
          methods.push(String(msg.method));
          fs.appendFileSync(path.join(opts.home, 'fake-daemon-methods.log'), msg.method + '\n');
          conn.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: REPLY }) + '\n');
        }
      }
    });
    conn.on('error', () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sock, resolve);
  });

  return {
    methods,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
