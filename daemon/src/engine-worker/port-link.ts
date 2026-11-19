/**
 * PortLink — a `DaemonLink` over a `MessagePort`, worker side. The main thread
 * wraps each link in a port sink and routes it through `SessionHost` exactly
 * like a socket session, so a link behaves like `DaemonClient` without a socket.
 *
 * Several links share one port. `PortLinkRouter` allocates `lid`s, opens links
 * and routes inbound `msg` / `link-end` to them; the worker core calls
 * `router.handle(m)` from the port's message handler.
 *
 * Imports no engine code: only `shared`, `node:*` and `./protocol`.
 *
 * @module engine-worker/port-link
 */
import crypto from 'node:crypto';
import { takePiggyback } from 'shared';
import type { DaemonLink, DialogEvent } from 'shared';
import type { LinkRequest, MainToWorker, WorkerToMain } from './protocol';

/** The slice of `MessagePort` a link needs. */
export interface PortLike {
  postMessage(msg: WorkerToMain): void;
}

interface Inflight {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export class PortLink implements DaemonLink {
  private inflight = new Map<string, Inflight>();
  private dialogEventBuffer: DialogEvent[] = [];
  private settleStart: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private ended = false;
  private _connected = false;
  private _browser = 'chrome';
  private _buildTime: string | null = null;
  private _configDrift = false;
  private _peers: string[] = [];
  private _version: string | null = null;
  private _extensionConnected = false;
  private _extensionVersionError: string | null = null;
  private _activeSessionCount: number | null = null;

  spawnReason?: 'not_running' | 'version_mismatch';
  onReconnect: (() => void) | null = null;
  onTabInfoUpdate: ((tabInfo: any) => void) | null = null;

  constructor(
    readonly lid: number,
    readonly sessionId: string,
    private readonly cid: string | undefined,
    private readonly port: PortLike,
    private readonly onGone: (lid: number) => void,
  ) {}

  get connected(): boolean { return this._connected; }
  get browser(): string { return this._browser; }
  get buildTime(): string | null { return this._buildTime; }
  get version(): string | null { return this._version; }
  get extensionConnected(): boolean { return this._extensionConnected; }
  get extensionVersionError(): string | null { return this._extensionVersionError; }
  get activeSessionCount(): number | null { return this._activeSessionCount; }
  isConfigDrifted(): boolean { return this._configDrift; }
  getPeerSessions(): string[] { return [...this._peers]; }

  consumeDialogEvents(): DialogEvent[] {
    const events = this.dialogEventBuffer;
    this.dialogEventBuffer = [];
    return events;
  }

  /** Ask main to register this session; resolves on `session_ack`, rejects on `session_reject` or after 10 s. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settleStart = null;
        this.gone();
        this.port.postMessage({ t: 'link-close', lid: this.lid });
        reject(new Error('Timeout connecting to daemon'));
      }, 10000);
      this.settleStart = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this.port.postMessage({ t: 'link-open', lid: this.lid, sessionId: this.sessionId, ...(this.cid !== undefined && { cid: this.cid }) });
    });
  }

  async sendCmd(method: string, params: Record<string, unknown> = {}, timeout: number = 60000): Promise<any> {
    if (!this._connected) throw new Error('Not connected to daemon. Call connect first.');

    const id = crypto.randomUUID().slice(0, 8);
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.inflight.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeout);
      this.inflight.set(id, {
        resolve: (result) => { clearTimeout(timeoutId); resolve(result); },
        reject: (error) => { clearTimeout(timeoutId); reject(error); },
      });
      const msg: LinkRequest = { jsonrpc: '2.0', id, method, params, timeout };
      this.port.postMessage({ t: 'req', lid: this.lid, msg });
    });
  }

  notifyClientId(_clientId: string): void {}

  /** Tell main to close the session and reject in-flight requests. */
  async stop(): Promise<void> {
    if (!this.ended) this.port.postMessage({ t: 'link-close', lid: this.lid });
    this.gone();
  }

  /** One object main's port sink was sent: the same dispatch as `DaemonClient`'s line handler. */
  onMsg(msg: any): void {
    if (msg.type === 'session_ack') {
      this._browser = msg.browser || 'chrome';
      this._buildTime = msg.buildTimestamp || null;
      this._connected = true;
      this.noteEnvelope(msg);
      this._version = msg.version || null;
      this._extensionConnected = msg.extensionConnected === true;
      this._extensionVersionError = typeof msg.extensionVersionError === 'string' ? msg.extensionVersionError : null;
      this._activeSessionCount = typeof msg.activeSessionCount === 'number' ? msg.activeSessionCount : null;
      this.settleStart?.resolve();
      this.settleStart = null;
      return;
    }
    if (msg.type === 'session_reject') {
      const s = this.settleStart;
      this.settleStart = null;
      this.gone();
      s?.reject(new Error(msg.reason || 'Session rejected by daemon'));
      return;
    }
    if (msg.jsonrpc === '2.0' && msg.id !== undefined) {
      this.noteEnvelope(msg);
      const pending = this.inflight.get(String(msg.id));
      if (!pending) return;
      this.inflight.delete(String(msg.id));
      if (msg.error) {
        pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        this.dialogEventBuffer.push(...takePiggyback(msg.result, this.onTabInfoUpdate));
        pending.resolve(msg.result);
      }
    }
  }

  /** Main ended the port sink. */
  onEnd(): void {
    const s = this.settleStart;
    this.settleStart = null;
    this.ended = true;
    this.gone();
    s?.reject(new Error('Daemon connection closed'));
  }

  private noteEnvelope(msg: any): void {
    if (msg.config_drift === true) this._configDrift = true;
    if (Array.isArray(msg.peers)) this._peers = msg.peers;
  }

  private gone(): void {
    this._connected = false;
    this.ended = true;
    for (const [, pending] of this.inflight) pending.reject(new Error('Daemon connection closed'));
    this.inflight.clear();
    this.onGone(this.lid);
  }
}

/** Opens links on one port and routes inbound `msg` / `link-end` to them. */
export class PortLinkRouter {
  private links = new Map<number, PortLink>();
  private nextLid = 1;

  constructor(private readonly port: PortLike) {}

  /** Open a link for the daemon session `sessionId` (opened for shim connection `cid`) and wait for its ack. */
  async open(sessionId: string, cid?: string): Promise<PortLink> {
    const lid = this.nextLid++;
    const link = new PortLink(lid, sessionId, cid, this.port, (l) => this.links.delete(l));
    this.links.set(lid, link);
    await link.start();
    return link;
  }

  /** Route a main-to-worker message; false when it is not a link message. */
  handle(m: MainToWorker): boolean {
    if (m.t === 'msg') this.links.get(m.lid)?.onMsg(m.msg);
    else if (m.t === 'link-end') this.links.get(m.lid)?.onEnd();
    else return false;
    return true;
  }
}
