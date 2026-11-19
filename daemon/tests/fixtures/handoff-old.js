// Test fixture: a minimal OLD daemon that runs the real `Handoff` from daemon/dist with the timing and
// fault options a test sets in <HOME>/fixture.json: { port, version, successorMain, readyMs,
// browserWaitMs, drainMs, killNoop }. It holds the pidfile and `daemon.sock`, answers `daemon_status`
// and `daemon_restart`, and has no sessions, shims or browsers.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { sockPath, pidPath, supersurfDir } = require('shared');
const { Handoff } = require('../../dist/handoff');

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(process.env.HOME, 'fixture.json'), 'utf8')); } catch {}

let restarting = false;
const handoff = new Handoff({
  version: cfg.version || '1.0.0',
  port: cfg.port,
  log: () => {},
  killOwnedChromium: () => [],
  userOwned: () => [],
  setRestarting: () => { restarting = true; },
  stopShims: async () => {},
  endSessions: async () => {},
  readyMs: cfg.readyMs,
  browserWaitMs: cfg.browserWaitMs,
  drainMs: cfg.drainMs,
  kill: cfg.killNoop ? () => {} : undefined,
  mainPath: cfg.successorMain,
});

fs.mkdirSync(supersurfDir(), { recursive: true });
fs.writeFileSync(pidPath(), String(process.pid));
const server = net.createServer((sock) => {
  let buf = '';
  sock.on('error', () => {});
  sock.on('data', (d) => {
    buf += d.toString();
    for (let i = buf.indexOf('\n'); i !== -1; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const reply = (m) => { sock.write(JSON.stringify(m) + '\n'); sock.end(); };
      if (restarting) return reply({ type: 'restarting' });
      if (msg.type === 'daemon_status') reply({ type: 'daemon_status', pid: process.pid, protocol: 1 });
      else if (msg.type === 'daemon_restart') {
        if (handoff.busy) reply({ type: 'handoff_in_progress' });
        else void handoff.run(reply);
      }
    }
  });
});
try { fs.unlinkSync(sockPath()); } catch {}
server.listen(sockPath(), () => console.log('fixture old daemon ready'));
