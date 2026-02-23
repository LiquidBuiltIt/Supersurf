/**
 * ConnectionManager — central state machine for the server's connection lifecycle.
 *
 * States:
 *   - **passive** — server is idle, only connection tools (enable/disable/status) are available
 *   - **active** — WebSocket server is listening, waiting for extension to connect
 *   - **connected** — extension linked, all browser tools available
 *
 * This module owns state transitions and tool dispatch. It delegates:
 *   - Tool schemas to `backend/schemas.ts`
 *   - Status header formatting to `backend/status.ts`
 *   - Handler implementations to `backend/handlers.ts`
 *
 * BrowserBridge is lazy-imported to break a circular dependency (tools.ts imports backend types).
 *
 * @module backend
 * @exports ConnectionManager
 * @exports BackendConfig, TabInfo, BackendState, ToolSchema (re-exported from backend/types)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { IExtensionTransport } from './bridge';
import { createLog } from './logger';

// Re-export types so existing imports from './backend' still work
export type { BackendConfig, TabInfo, BackendState, ToolSchema } from './backend/types';
import type { BackendConfig, TabInfo, BackendState, ToolSchema, ConnectionManagerAPI } from './backend/types';

import { buildStatusHeader } from './backend/status';
import { getConnectionToolSchemas, getDebugToolSchema } from './backend/schemas';
import { onEnable, onDisable, onStatus, onExperimentalFeatures, onReloadMCP } from './backend/handlers';

const log = createLog('[Conn]');

// Lazy-load BrowserBridge to avoid circular dependency: tools.ts imports types from backend
let BrowserBridge: any = null;

/** Lazy singleton loader for BrowserBridge class. */
async function getBrowserBridge(): Promise<any> {
  if (!BrowserBridge) {
    const mod = await import('./tools');
    BrowserBridge = mod.BrowserBridge;
  }
  return BrowserBridge;
}

/**
 * Core state machine for managing the extension connection lifecycle.
 * Implements ConnectionManagerAPI so handler functions can read/write state.
 */
export class ConnectionManager implements ConnectionManagerAPI {
  config: BackendConfig;
  state: BackendState = 'passive';
  bridge: any = null;
  extensionServer: IExtensionTransport | null = null;
  debugMode: boolean;
  clientId: string | null = null;
  connectedBrowserName: string | null = null;
  attachedTab: TabInfo | null = null;
  stealthMode: boolean = false;
  server: Server | null = null;
  clientInfo: Record<string, unknown> = {};

  constructor(config: BackendConfig) {
    log('Constructor — starting in PASSIVE mode');
    this.config = config;
    this.debugMode = config.debug || false;
  }

  /** Store server reference and client metadata. Does not start the WebSocket — that happens in `enable`. */
  async initialize(server: Server | null, clientInfo: Record<string, unknown>): Promise<void> {
    log('Initialize called — staying in passive mode');
    this.server = server;
    this.clientInfo = clientInfo;
  }

  // ─── Status header ─────────────────────────────────────────

  /** Build a one-line status string prepended to every tool response. */
  statusHeader(): string {
    return buildStatusHeader({
      config: this.config,
      state: this.state,
      debugMode: this.debugMode,
      connectedBrowserName: this.connectedBrowserName,
      attachedTab: this.attachedTab,
      stealthMode: this.stealthMode,
      extensionServer: this.extensionServer,
    });
  }

  // ─── Tool listing ──────────────────────────────────────────

  /** Return all available tool schemas: connection tools + browser tools + debug tools (if enabled). */
  async listTools(): Promise<ToolSchema[]> {
    log(`listTools() — state: ${this.state}`);

    const connectionTools = getConnectionToolSchemas();

    // Get browser tools from BrowserBridge (dummy transport, schema only)
    const BB = await getBrowserBridge();
    const dummyBridge = new BB(this.config, null);
    const browserTools = await dummyBridge.listTools();

    const debugTools: ToolSchema[] = [];
    if (this.debugMode) {
      debugTools.push(getDebugToolSchema());
    }

    return [...connectionTools, ...browserTools, ...debugTools];
  }

  // ─── Tool dispatch ─────────────────────────────────────────

  /**
   * Dispatch a tool call. Connection tools are handled locally; browser tools
   * forward to BrowserBridge. Returns MCP content response or raw JSON (script mode).
   * @param rawResult - When true, return plain objects instead of MCP content wrappers
   */
  async callTool(
    name: string,
    rawArguments: Record<string, unknown> = {},
    options: { rawResult?: boolean } = {}
  ): Promise<any> {
    log(`callTool(${name}) — state: ${this.state}`);

    switch (name) {
      case 'enable':
        return await onEnable(this, rawArguments, options);
      case 'disable':
        return await onDisable(this, options);
      case 'status':
        return await onStatus(this, options);
      case 'experimental_features':
        return await onExperimentalFeatures(this, rawArguments, options);
      case 'reload_mcp':
        return onReloadMCP(this, options);
    }

    // Forward to active bridge
    if (!this.bridge) {
      if (options.rawResult) {
        return {
          success: false,
          error: 'not_enabled',
          message: 'Browser automation not active. Call enable first.',
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: `### ⚠️ Browser Automation Not Active\n\n**Current State:** Passive (disabled)\n\n**You must call \`enable\` first to activate browser automation.**`,
          },
        ],
        isError: true,
      };
    }

    return await this.bridge.callTool(name, rawArguments, options);
  }

  // ─── Notify tools changed ──────────────────────────────────

  /** Signal MCP client that the available tool list has changed (e.g., after enable/disable). */
  async notifyToolsListChanged(): Promise<void> {
    if (this.server) {
      try {
        await (this.server as any).sendToolsListChanged?.();
      } catch {
        // Client may not support this notification
      }
    }
  }

  // ─── Logging notifications ───────────────────────────────

  /** Send an MCP logging notification to the client (info, warn, error). Silently no-ops if unsupported. */
  async sendLogNotification(level: string, message: string, logger?: string): Promise<void> {
    if (this.server) {
      try {
        const hasMethod = typeof (this.server as any).sendLoggingMessage === 'function';
        log(`sendLogNotification: hasMethod=${hasMethod}, level=${level}, logger=${logger || 'supersurf'}`);
        if (hasMethod) {
          await (this.server as any).sendLoggingMessage({
            level,
            logger: logger || 'supersurf',
            data: message,
          });
          log('sendLogNotification: sent successfully');
        } else {
          log('sendLogNotification: method not found on server instance');
        }
      } catch (err: any) {
        log('sendLogNotification error:', err?.message || err);
      }
    } else {
      log('sendLogNotification: no server instance');
    }
  }

  // ─── Public accessors for BrowserBridge to update state ────

  setAttachedTab(tab: TabInfo | null): void {
    this.attachedTab = tab;
  }

  getAttachedTab(): TabInfo | null {
    return this.attachedTab;
  }

  clearAttachedTab(): void {
    this.attachedTab = null;
  }

  setConnectedBrowserName(name: string): void {
    this.connectedBrowserName = name;
  }

  setStealthMode(enabled: boolean): void {
    this.stealthMode = enabled;
  }

  // ─── Shutdown ──────────────────────────────────────────────

  /** Tear down bridge, stop WebSocket server, reset to passive. Called on SIGINT or explicit shutdown. */
  async serverClosed(): Promise<void> {
    log('Server closed');

    if (this.bridge) {
      this.bridge.serverClosed();
      this.bridge = null;
    }

    if (this.extensionServer) {
      await this.extensionServer.stop();
      this.extensionServer = null;
    }

    this.state = 'passive';
  }
}
