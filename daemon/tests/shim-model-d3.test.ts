/**
 * D3 upgrade pending, real daemons (E4 items 10-11): a built `dist/main.js` in a throwaway HOME on a
 * free port. The pending check runs on a 5 s interval and when the session count reaches 0.
 * Needs `npm run build.daemon` first.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { DaemonRig, PKG_VERSION, waitFor, sleep, MAIN } from './helpers/real-daemon';
import { isProcessAlive } from 'shared';
import fs from 'fs';
import net from 'net';

const missing = !fs.existsSync(MAIN);
const RELAY = { SUPERSURF_RELAY: '1' };

let rig: DaemonRig;
afterEach(() => rig?.cleanup());

describe.skipIf(missing)('D3 upgrade pending (real daemon)', () => {
  it('entry newer + shim model on + zero sessions: exits with reason upgrade_pending', async () => {
    rig = new DaemonRig();
    rig.writeEntry('99.0.0');
    const pid = await rig.start([], RELAY);
    const st = await rig.status();
    expect(st.shimModel).toBe(true);
    expect(st.upgradePending).toEqual({ from: PKG_VERSION, to: '99.0.0' });
    await waitFor(() => !isProcessAlive(pid), 9000, 'the daemon to exit');
    expect(rig.daemonLog()).toContain('Shutting down (reason=upgrade_pending)');
  }, 20000);

  it('a live legacy session blocks the exit; closing it triggers it at once', async () => {
    rig = new DaemonRig();
    rig.writeEntry('99.0.0');
    const pid = await rig.start([], RELAY);
    const s = await rig.legacySession('legacy-1');
    await sleep(6500); // past one 5 s tick
    expect(isProcessAlive(pid)).toBe(true);
    expect((await rig.status()).upgradePending).toEqual({ from: PKG_VERSION, to: '99.0.0' });
    s.close();
    await waitFor(() => !isProcessAlive(pid), 3000, 'the exit after the last session closed');
    expect(rig.daemonLog()).toContain('reason=upgrade_pending');
  }, 20000);

  it('a newer entry alone (relay off, no shim served, not shim-started) is a legacy daemon: no shim model, no upgrade_pending exit', async () => {
    rig = new DaemonRig();
    rig.writeEntry('99.0.0');
    const pid = await rig.start();
    await sleep(6500);
    expect(isProcessAlive(pid)).toBe(true);
    const st = await rig.status();
    expect(st.shimModel).toBe(false);
    expect(st.upgradePending).toBeUndefined();
    expect(rig.daemonLog()).not.toContain('upgrade_pending');
  }, 20000);

  it('agents.relay on, no entry file: shimModel is true', async () => {
    rig = new DaemonRig();
    await rig.start([], RELAY);
    expect((await rig.status()).shimModel).toBe(true);
  }, 20000);

  it('a legacy daemon (no entry, no shim) never exits for this reason and reports no shim model', async () => {
    rig = new DaemonRig();
    const pid = await rig.start();
    await sleep(6500);
    expect(isProcessAlive(pid)).toBe(true);
    const st = await rig.status();
    expect(st.shimModel).toBe(false);
    expect(st.upgradePending).toBeUndefined();
    expect(rig.daemonLog()).not.toContain('upgrade_pending');
  }, 20000);

  it('an entry that is not newer is no upgrade', async () => {
    rig = new DaemonRig();
    rig.writeEntry(PKG_VERSION);
    const pid = await rig.start([], RELAY);
    await sleep(6500);
    expect(isProcessAlive(pid)).toBe(true);
    const st = await rig.status();
    expect(st.shimModel).toBe(true);
    expect(st.upgradePending).toBeUndefined();
  }, 20000);

  it('status prints one upgrade-pending line', async () => {
    rig = new DaemonRig();
    rig.writeEntry('99.0.0');
    await rig.start([], RELAY);
    const s = await rig.legacySession('legacy-2');
    const r = await rig.cli(['status']);
    s.close();
    expect(r.code).toBe(0);
    const lines = r.out.split('\n').filter((l) => l.includes('Upgrade pending'));
    expect(lines).toEqual([`Upgrade pending: ${PKG_VERSION} -> 99.0.0; the daemon restarts when no agent is connected (1 session, legacy and shim counted together).`]);
  }, 20000);

  it('started by the shim (no entry file): shimModel is true', async () => {
    rig = new DaemonRig();
    await rig.start(['--spawned-by=shim']);
    expect((await rig.status()).shimModel).toBe(true);
  }, 20000);

  it('an accepted shim_register turns the shim model on for good', async () => {
    rig = new DaemonRig();
    await rig.start();
    expect((await rig.status()).shimModel).toBe(false);
    const sock = net.createConnection(rig.sock);
    let buf = '';
    sock.on('data', (d) => { buf += d; });
    sock.on('error', () => {});
    sock.write(JSON.stringify({ type: 'shim_register', protocol: 1, mode: 'mcp', sessionId: 'shim-0123456789abcdef', version: '0', cwd: '/', flags: {}, env: {}, caps: [] }) + '\n');
    await waitFor(() => buf.includes('shim_ack'), 10000, 'shim_ack');
    sock.destroy();
    await waitFor(async () => (await rig.status()).shimSessions === 0, 3000, 'the shim socket to close');
    expect((await rig.status()).shimModel).toBe(true);
  }, 20000);
});
