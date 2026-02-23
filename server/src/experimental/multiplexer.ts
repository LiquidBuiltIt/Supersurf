/**
 * Multiplexer — session multiplexing for concurrent MCP clients.
 *
 * Implements IExtensionTransport. On start(), tries to bind the port (leader mode).
 * If port is taken, connects as a follower through the existing leader.
 * Followers transparently proxy commands through the leader to the extension.
 *
 * Leader responsibilities:
 *   - Accept extension connections (delegated to ExtensionServer)
 *   - Accept peer (follower) connections, proxy their requests to the extension
 *   - Track tab ownership per session (selectTab/createTab claim, closeTab releases)
 *   - Round-robin scheduler: one tool call per session turn, auto context-switch
 *   - Broadcast reconnect/tab-info events to relevant peers
 *   - Inject _sessionId into all commands for extension-side group isolation
 *
 * Follower responsibilities:
 *   - Connect to leader via WebSocket, send peer handshake
 *   - Forward sendCmd() calls through leader, manage own inflight map
 *   - On leader disconnect, attempt promotion (race with other followers)
 */

import crypto from 'crypto';
import http from 'http';
import { WebSocket } from 'ws';
import { ExtensionServer, type IExtensionTransport } from '../bridge';
import { createLog } from '../logger';

const log = createLog('[Mux]');

// Methods that modify tab ownership
const TAB_CLAIM_METHODS = new Set(['selectTab', 'createTab']);
const TAB_RELEASE_METHODS = new Set(['closeTab']);

// Methods where we need to ensure the correct tab is active before executing
// (basically everything except tab management and non-tab-scoped calls)
const TAB_SCOPED_METHODS = new Set([
  'navigate', 'snapshot', 'evaluate', 'screenshot',
  'consoleMessages', 'networkRequests', 'clearNetwork',
  'performanceMetrics', 'waitForReady', 'capturePageState',
  'forwardCDPCommand', 'window', 'dialog',
  'listExtensions', 'reloadExtension', 'secure_fill',
]);

/** Pending promise callbacks for a follower's in-flight request to the leader. */
interface InflightRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/** State tracked per connected peer (follower) session on the leader. */
interface PeerSession {
  ws: WebSocket;
  sessionId: string;
  ownedTabs: Set<number>;
  attachedTabId: number | null; // tab ID (not index)
  groupId: number | null;
  pingInterval: ReturnType<typeof setInterval>;
}

/** A request waiting in the round-robin scheduler queue. */
interface QueuedRequest {
  sessionId: string;
  method: string;
  params: Record<string, unknown>;
  timeout: number;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

type MultiplexerMode = 'leader' | 'follower';

/**
 * Session multiplexer for concurrent MCP clients sharing one Chrome extension.
 *
 * Implements IExtensionTransport so it can be used as a drop-in replacement
 * for ExtensionServer. On start(), tries to bind the WebSocket port:
 * - Success: becomes the **leader** — accepts extension + peer connections,
 *   manages tab ownership, runs round-robin scheduler.
 * - EADDRINUSE: becomes a **follower** — proxies commands through the leader.
 *
 * If the leader goes down, followers race to promote (with random jitter to
 * avoid thundering herd).
 */
export class Multiplexer implements IExtensionTransport {
  private port: number;
  private host: string;
  private sessionId: string;
  private mode: MultiplexerMode | null = null;

  // Leader state
  private extensionServer: ExtensionServer | null = null;
  private peers: Map<string, PeerSession> = new Map();
  private leaderTabOwnership: Map<string, Set<number>> = new Map();
  private leaderAttachedTabId: number | null = null; // leader session's attached tab ID
  private leaderGroupId: number | null = null;

  // Scheduler state
  private requestQueue: Map<string, QueuedRequest[]> = new Map();
  private sessionOrder: string[] = []; // round-robin ordering
  private currentSessionIdx: number = 0;
  private processingQueue: boolean = false;
  private currentExtensionTabId: number | null = null; // what tab the extension actually has attached

  // Session → groupId cache
  private sessionGroupIds: Map<string, number> = new Map();

  // Follower state
  private leaderSocket: WebSocket | null = null;
  private inflight: Map<string, InflightRequest> = new Map();
  private _browser: string = 'chrome';
  private _buildTime: string | null = null;
  private _connected: boolean = false;
  private promotionInProgress: boolean = false;

  // IExtensionTransport callbacks
  onReconnect: (() => void) | null = null;
  onTabInfoUpdate: ((tabInfo: any) => void) | null = null;

  constructor(port: number = 5555, host: string = '127.0.0.1', sessionId: string) {
    this.port = port;
    this.host = host;
    this.sessionId = sessionId;
  }

  get connected(): boolean {
    if (this.mode === 'leader') {
      return this.extensionServer?.connected ?? false;
    }
    return this._connected;
  }

  get browser(): string {
    if (this.mode === 'leader') {
      return this.extensionServer?.browser ?? this._browser;
    }
    return this._browser;
  }

  get buildTime(): string | null {
    if (this.mode === 'leader') {
      return this.extensionServer?.buildTime ?? this._buildTime;
    }
    return this._buildTime;
  }

  // ─── Start ────────────────────────────────────────────────────

  /**
   * Attempt to start as leader; fall back to follower if port is taken.
   * This is the only public entry point for initialization.
   */
  async start(): Promise<void> {
    try {
      await this.startAsLeader();
    } catch (error: any) {
      if (error.code === 'EADDRINUSE' ||
          error.message?.includes('EADDRINUSE') ||
          error.message?.includes('address already in use')) {
        log(`Port ${this.port} in use — connecting as follower`);
        await this.startAsFollower();
      } else {
        throw error;
      }
    }
  }

  // ─── Leader Mode ──────────────────────────────────────────────

  /** Bind the port, start WebSocket server, and initialize leader state (queues, tab ownership). */
  private async startAsLeader(): Promise<void> {
    this.extensionServer = new ExtensionServer(this.port, this.host);

    // Intercept raw connections — route peers by URL path, pass extension through
    this.extensionServer.onRawConnection = (ws: WebSocket, request: http.IncomingMessage): boolean => {
      const url = new URL(request.url || '/', `http://${request.headers.host}`);
      if (url.pathname === '/peer') {
        const peerSessionId = url.searchParams.get('session');
        if (peerSessionId) {
          this.acceptPeer(ws, peerSessionId);
          return true; // handled — don't let ExtensionServer touch it
        }
      }
      return false; // extension connection — ExtensionServer handles it
    };

    await this.extensionServer.start();
    this.mode = 'leader';
    this.leaderTabOwnership.set(this.sessionId, new Set());
    this.requestQueue.set(this.sessionId, []);
    this.sessionOrder = [this.sessionId];
    log(`Leader mode — listening on ${this.host}:${this.port}, session="${this.sessionId}"`);
  }

  /** Register a new follower connection. Sets up message routing, ownership tracking, and cleanup on close. */
  private acceptPeer(ws: WebSocket, peerSessionId: string): void {
    // Session dedup
    if (this.peers.has(peerSessionId)) {
      log(`Rejecting peer — session "${peerSessionId}" already in use`);
      ws.send(JSON.stringify({
        type: 'peer_reject',
        reason: 'session name already in use',
      }));
      setTimeout(() => ws.close(1008, 'Session name already in use'), 100);
      return;
    }

    log(`Peer accepted: "${peerSessionId}"`);

    // Send ack with browser info
    ws.send(JSON.stringify({
      type: 'peer_ack',
      browser: this.extensionServer?.browser ?? 'chrome',
      buildTimestamp: this.extensionServer?.buildTime ?? null,
    }));

    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 10000);

    const peer: PeerSession = {
      ws,
      sessionId: peerSessionId,
      ownedTabs: new Set(),
      attachedTabId: null,
      groupId: null,
      pingInterval,
    };

    this.peers.set(peerSessionId, peer);
    this.leaderTabOwnership.set(peerSessionId, peer.ownedTabs);
    this.requestQueue.set(peerSessionId, []);
    this.sessionOrder.push(peerSessionId);

    ws.on('message', (data) => this.handlePeerMessage(peer, data));

    ws.on('close', () => {
      log(`Peer disconnected: "${peerSessionId}"`);
      clearInterval(pingInterval);
      this.peers.delete(peerSessionId);
      this.leaderTabOwnership.delete(peerSessionId);
      this.sessionGroupIds.delete(peerSessionId);

      // Notify extension to ungroup the session's tabs
      this.extensionServer?.sendCmd('sessionDisconnect', { sessionId: peerSessionId }, 5000).catch(() => {});

      // Drain and reject any queued requests for this session
      const queued = this.requestQueue.get(peerSessionId) || [];
      for (const req of queued) {
        req.reject(new Error('Session disconnected'));
      }
      this.requestQueue.delete(peerSessionId);
      this.sessionOrder = this.sessionOrder.filter(s => s !== peerSessionId);
      if (this.currentSessionIdx >= this.sessionOrder.length) {
        this.currentSessionIdx = 0;
      }
    });

    ws.on('error', (error) => {
      log(`Peer error (${peerSessionId}):`, error.message);
    });
  }

  /** Parse incoming JSON-RPC from a peer and enqueue it in the round-robin scheduler. */
  private async handlePeerMessage(peer: PeerSession, data: any): Promise<void> {
    try {
      const msg = JSON.parse(data.toString());

      // JSON-RPC request from peer — enqueue it
      if (msg.jsonrpc === '2.0' && msg.method && msg.id !== undefined) {
        this.enqueueRequest(
          peer.sessionId,
          msg.method,
          msg.params || {},
          msg.timeout || 30000,
          (result) => {
            peer.ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result,
            }));
          },
          (error) => {
            peer.ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32000, message: error.message || String(error) },
            }));
          }
        );
      }
    } catch (error) {
      log('Error handling peer message:', error);
    }
  }

  // ─── Request Queue & Round-Robin Scheduler ─────────────────────

  /** Add a request to the session's queue and trigger the drain loop. */
  private enqueueRequest(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
    timeout: number,
    resolve: (value: unknown) => void,
    reject: (reason: Error) => void
  ): void {
    const queue = this.requestQueue.get(sessionId);
    if (!queue) {
      reject(new Error('Unknown session'));
      return;
    }

    queue.push({ sessionId, method, params, timeout, resolve, reject });
    this.drainQueue();
  }

  /** Process queued requests in round-robin order until all queues are empty. Serialized — only one drain loop runs at a time. */
  private async drainQueue(): Promise<void> {
    if (this.processingQueue) return;
    this.processingQueue = true;

    try {
      while (this.hasQueuedRequests()) {
        const request = this.pickNextRequest();
        if (!request) break;

        await this.executeRequest(request);
      }
    } finally {
      this.processingQueue = false;
    }
  }

  private hasQueuedRequests(): boolean {
    for (const queue of this.requestQueue.values()) {
      if (queue.length > 0) return true;
    }
    return false;
  }

  /**
   * Round-robin pick: advance through sessions, skip empty queues.
   */
  private pickNextRequest(): QueuedRequest | null {
    if (this.sessionOrder.length === 0) return null;

    const startIdx = this.currentSessionIdx;
    let checked = 0;

    while (checked < this.sessionOrder.length) {
      const sessionId = this.sessionOrder[this.currentSessionIdx];
      const queue = this.requestQueue.get(sessionId);

      // Advance to next session for next pick
      this.currentSessionIdx = (this.currentSessionIdx + 1) % this.sessionOrder.length;
      checked++;

      if (queue && queue.length > 0) {
        return queue.shift()!;
      }
    }

    return null;
  }

  /**
   * Execute a single queued request:
   * 1. Tab ownership check for tab-management methods
   * 2. Auto context-switch (selectTab by ID) if this session's tab != current extension tab
   * 3. Inject _sessionId for extension-side group isolation
   * 4. Execute the actual command
   * 5. Track ownership changes
   */
  private async executeRequest(request: QueuedRequest): Promise<void> {
    const { sessionId, method, params, timeout, resolve, reject } = request;

    try {
      // ── Tab ownership enforcement ──
      if (TAB_CLAIM_METHODS.has(method)) {
        if (method === 'selectTab') {
          // Check by tab ID if provided, else fall back to index-based check
          const tabId = params.tabId as number | undefined;
          if (tabId !== undefined) {
            const owner = this.findTabOwnerByTabId(tabId);
            if (owner && owner !== sessionId) {
              reject(new Error(`Tab ${tabId} is owned by session "${owner}". Cannot attach.`));
              return;
            }
          }
        }
      }

      if (TAB_RELEASE_METHODS.has(method)) {
        const tabId = params.tabId as number | undefined;
        if (tabId !== undefined) {
          const owner = this.findTabOwnerByTabId(tabId);
          if (owner && owner !== sessionId) {
            reject(new Error(`Tab ${tabId} is owned by session "${owner}". Cannot close.`));
            return;
          }
        }
      }

      // ── Auto context-switch ──
      // If this is a tab-scoped method and the session has an attached tab
      // that differs from what the extension currently has, switch first.
      if (TAB_SCOPED_METHODS.has(method) || !TAB_CLAIM_METHODS.has(method) && !TAB_RELEASE_METHODS.has(method) && method !== 'getTabs') {
        const sessionTabId = this.getSessionAttachedTabId(sessionId);
        if (sessionTabId !== null && sessionTabId !== this.currentExtensionTabId) {
          log(`Context-switch: tab ${this.currentExtensionTabId} → ${sessionTabId} (session="${sessionId}")`);
          try {
            await this.extensionServer!.sendCmd('selectTab', { tabId: sessionTabId, _sessionId: sessionId }, 5000);
            this.currentExtensionTabId = sessionTabId;
          } catch (err: any) {
            log(`Context-switch failed: ${err.message}`);
            // Continue anyway — the command might still work
          }
        }
      }

      // ── Inject _sessionId for extension-side group isolation ──
      const enrichedParams = { ...params, _sessionId: sessionId };

      // ── Execute the actual command ──
      const result = await this.extensionServer!.sendCmd(method, enrichedParams, timeout);

      // ── Track ownership changes ──
      if (method === 'createTab') {
        const tabId = result?.attachedTab?.id ?? result?.id;
        const groupId = result?.attachedTab?.groupId;
        if (tabId) {
          const tabs = this.leaderTabOwnership.get(sessionId);
          if (tabs) tabs.add(tabId);
          this.setSessionAttachedTabId(sessionId, tabId);
          this.currentExtensionTabId = tabId;
        }
        if (groupId !== undefined && groupId !== -1) {
          this.sessionGroupIds.set(sessionId, groupId);
          this.setSessionGroupId(sessionId, groupId);
        }
      }

      if (method === 'selectTab') {
        const tabId = result?.attachedTab?.id ?? result?.id;
        const groupId = result?.attachedTab?.groupId;
        if (tabId) {
          const tabs = this.leaderTabOwnership.get(sessionId);
          if (tabs) tabs.add(tabId);
          this.setSessionAttachedTabId(sessionId, tabId);
          this.currentExtensionTabId = tabId;
        }
        if (groupId !== undefined && groupId !== -1) {
          this.sessionGroupIds.set(sessionId, groupId);
          this.setSessionGroupId(sessionId, groupId);
        }
      }

      if (method === 'closeTab') {
        // Clear the session's attached tab if it was the one closed
        const sessionTabId = this.getSessionAttachedTabId(sessionId);
        if (sessionTabId !== null) {
          // Remove from ownership set
          const tabs = this.leaderTabOwnership.get(sessionId);
          if (tabs) tabs.delete(sessionTabId);
          this.setSessionAttachedTabId(sessionId, null);
        }
      }

      // ── Filter getTabs results (defense-in-depth) ──
      if (method === 'getTabs') {
        // Extension already filters by group when _sessionId is present,
        // but we keep server-side filtering as a safety net
        const tabsResult = result?.tabs ?? result;
        if (Array.isArray(tabsResult)) {
          const filtered = this.filterTabsForSession(sessionId, tabsResult);
          if (result?.tabs) {
            resolve({ ...result, tabs: filtered });
          } else {
            resolve(filtered);
          }
          return;
        }
      }

      resolve(result);
    } catch (error: any) {
      reject(error);
    }
  }

  // ─── Tab Ownership Helpers ─────────────────────────────────────

  private getSessionAttachedTabId(sessionId: string): number | null {
    if (sessionId === this.sessionId) {
      return this.leaderAttachedTabId;
    }
    const peer = this.peers.get(sessionId);
    return peer?.attachedTabId ?? null;
  }

  private setSessionAttachedTabId(sessionId: string, tabId: number | null): void {
    if (sessionId === this.sessionId) {
      this.leaderAttachedTabId = tabId;
    } else {
      const peer = this.peers.get(sessionId);
      if (peer) peer.attachedTabId = tabId;
    }
  }

  private setSessionGroupId(sessionId: string, groupId: number | null): void {
    if (sessionId === this.sessionId) {
      this.leaderGroupId = groupId;
    } else {
      const peer = this.peers.get(sessionId);
      if (peer) peer.groupId = groupId;
    }
  }

  /**
   * Find which session owns a tab by its ID.
   */
  private findTabOwnerByTabId(tabId: number): string | null {
    for (const [sid, ownedTabs] of this.leaderTabOwnership) {
      if (ownedTabs.has(tabId)) return sid;
    }
    return null;
  }

  /**
   * Filter tab list — show tabs owned by this session + unowned tabs.
   * Defense-in-depth: extension already filters by group via _sessionId.
   */
  private filterTabsForSession(sessionId: string, tabs: any[]): any[] {
    const allOwnedTabIds = new Set<number>();
    for (const [sid, ownedTabs] of this.leaderTabOwnership) {
      if (sid === sessionId) continue;
      for (const tabId of ownedTabs) {
        allOwnedTabIds.add(tabId);
      }
    }

    return tabs.filter((tab: any) => !allOwnedTabIds.has(tab.id));
  }

  // ─── Follower Mode ────────────────────────────────────────────

  /** Connect to an existing leader via WebSocket /peer endpoint. Resolves on peer_ack, rejects on timeout or rejection. */
  private async startAsFollower(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws://${this.host}:${this.port}/peer?session=${encodeURIComponent(this.sessionId)}`;
      log(`Connecting to leader at ${url}`);

      this.leaderSocket = new WebSocket(url);

      const connectTimeout = setTimeout(() => {
        // Clean up socket to prevent close event from triggering promotion
        if (this.leaderSocket) {
          this.leaderSocket.removeAllListeners();
          this.leaderSocket.close();
          this.leaderSocket = null;
        }
        reject(new Error(`Timeout connecting to leader at ws://${this.host}:${this.port}`));
      }, 10000);

      this.leaderSocket.on('open', () => {
        log('Connected to leader as peer');
      });

      this.leaderSocket.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());

          // Handshake response
          if (msg.type === 'peer_ack') {
            clearTimeout(connectTimeout);
            this._browser = msg.browser || 'chrome';
            this._buildTime = msg.buildTimestamp || null;
            this._connected = true;
            this.mode = 'follower';
            log(`Follower mode — connected through leader, session="${this.sessionId}"`);
            resolve();
            return;
          }

          if (msg.type === 'peer_reject') {
            clearTimeout(connectTimeout);
            const error = new Error(msg.reason || 'Peer connection rejected');
            (error as any).code = 'PEER_REJECTED';
            reject(error);
            return;
          }

          // JSON-RPC response
          if (msg.jsonrpc === '2.0' && msg.id !== undefined && !msg.method) {
            const pending = this.inflight.get(msg.id);
            if (pending) {
              this.inflight.delete(msg.id);
              if (msg.error) {
                pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
              } else {
                pending.resolve(msg.result);
              }
            }
            return;
          }

          // Event relay from leader
          if (msg.type === 'reconnect') {
            if (this.onReconnect) this.onReconnect();
            return;
          }

          if (msg.type === 'tab_info_update') {
            if (this.onTabInfoUpdate) this.onTabInfoUpdate(msg.tabInfo);
            return;
          }
        } catch (error) {
          log('Error handling leader message:', error);
        }
      });

      this.leaderSocket.on('close', () => {
        log('Leader connection closed');
        this._connected = false;

        if (!this.promotionInProgress) {
          this.attemptPromotion();
        }
      });

      this.leaderSocket.on('error', (error: any) => {
        log('Leader connection error:', error.message);
        if (this.mode === null) {
          clearTimeout(connectTimeout);
          reject(error);
        }
      });
    });
  }

  // ─── Leader Promotion ─────────────────────────────────────────

  /**
   * Race to become leader after the current leader disconnects.
   * Uses random jitter (50-200ms) to reduce collision likelihood.
   * If another follower wins, backs off and reconnects as follower.
   */
  private async attemptPromotion(): Promise<void> {
    if (this.promotionInProgress) return;
    this.promotionInProgress = true;

    // Random jitter to avoid thundering herd
    const jitter = 50 + Math.random() * 150;
    log(`Leader down — attempting promotion in ${Math.round(jitter)}ms`);

    await new Promise(r => setTimeout(r, jitter));

    try {
      await this.startAsLeader();
      log('Promoted to leader');

      // Wire up callbacks
      if (this.extensionServer) {
        this.extensionServer.onReconnect = () => {
          if (this.onReconnect) this.onReconnect();
          // Relay to peers
          for (const peer of this.peers.values()) {
            if (peer.ws.readyState === WebSocket.OPEN) {
              peer.ws.send(JSON.stringify({ type: 'reconnect' }));
            }
          }
        };

        this.extensionServer.onTabInfoUpdate = (tabInfo: any) => {
          if (this.onTabInfoUpdate) this.onTabInfoUpdate(tabInfo);
          // Relay to peers
          for (const peer of this.peers.values()) {
            if (peer.ws.readyState === WebSocket.OPEN) {
              peer.ws.send(JSON.stringify({ type: 'tab_info_update', tabInfo }));
            }
          }
        };
      }
    } catch (error: any) {
      if (error.code === 'EADDRINUSE' ||
          error.message?.includes('EADDRINUSE') ||
          error.message?.includes('address already in use')) {
        log('Another follower won the promotion race — reconnecting as follower');
        // Back off and reconnect
        await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
        try {
          await this.startAsFollower();
        } catch (reconnectError: any) {
          log('Failed to reconnect as follower:', reconnectError.message);
        }
      } else {
        log('Promotion failed:', error.message);
      }
    } finally {
      this.promotionInProgress = false;
    }
  }

  // ─── IExtensionTransport: sendCmd ─────────────────────────────

  /**
   * Send a command to the extension. Leader enqueues through the scheduler for
   * fair round-robin; follower proxies through the leader via JSON-RPC.
   */
  async sendCmd(method: string, params: Record<string, unknown> = {}, timeout: number = 30000): Promise<any> {
    if (this.mode === 'leader') {
      // Leader's own requests go through the same queue for fair scheduling
      return new Promise((resolve, reject) => {
        this.enqueueRequest(this.sessionId, method, params, timeout, resolve, reject);
      });
    }

    if (this.mode === 'follower') {
      return this.sendCmdAsFollower(method, params, timeout);
    }

    throw new Error('Multiplexer not started');
  }

  /** Forward a command to the leader as a JSON-RPC request. Manages timeout and inflight tracking. */
  private sendCmdAsFollower(method: string, params: Record<string, unknown>, timeout: number): Promise<any> {
    if (!this.leaderSocket || this.leaderSocket.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to leader. Extension may be restarting.');
    }

    const id = crypto.randomUUID().slice(0, 8);

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.inflight.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeout);

      this.inflight.set(id, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });

      const message = { jsonrpc: '2.0', id, method, params, timeout };
      this.leaderSocket!.send(JSON.stringify(message));
    });
  }

  // ─── IExtensionTransport: notifyClientId ──────────────────────

  notifyClientId(clientId: string): void {
    if (this.mode === 'leader' && this.extensionServer) {
      this.extensionServer.notifyClientId(clientId);
    }
    // Followers don't notify — leader handles client identity toward the extension
  }

  // ─── IExtensionTransport: stop ────────────────────────────────

  /** Tear down all state: drain queues, close peers, stop extension server, reject inflight requests. */
  async stop(): Promise<void> {
    log(`Stopping (mode=${this.mode})`);

    // Drain and reject all queued requests
    for (const [, queue] of this.requestQueue) {
      for (const req of queue) {
        req.reject(new Error('Multiplexer stopped'));
      }
    }
    this.requestQueue.clear();
    this.sessionOrder = [];

    // Always clean up peer connections (leader state)
    for (const peer of this.peers.values()) {
      clearInterval(peer.pingInterval);
      peer.ws.close(1001, 'Leader shutting down');
    }
    this.peers.clear();
    this.leaderTabOwnership.clear();
    this.sessionGroupIds.clear();

    // Always clean up extension server if it exists
    if (this.extensionServer) {
      await this.extensionServer.stop();
      this.extensionServer = null;
    }

    // Always clean up inflight requests and leader socket (follower state)
    for (const [, pending] of this.inflight) {
      pending.reject(new Error('Multiplexer stopped'));
    }
    this.inflight.clear();

    if (this.leaderSocket) {
      this.leaderSocket.removeAllListeners();
      this.leaderSocket.close();
      this.leaderSocket = null;
    }

    this._connected = false;
    this.mode = null;
  }
}
