/**
 * Connection-level tool handlers — connect, disconnect, status, experimental features, reload.
 *
 * Each handler receives the ConnectionManagerAPI (mutable state), the tool arguments,
 * and an options object. Handlers return either MCP content responses (for MCP mode)
 * or raw JSON objects (for script mode via `rawResult: true`).
 *
 * State transitions managed here:
 *   - `onConnect`:  passive -> active (spawns daemon, connects via DaemonClient, creates BrowserBridge)
 *   - `onDisconnect`: active/connected -> passive (closes daemon session)
 *   - `onReloadMCP`: triggers exit code 42 for the debug wrapper to restart
 *
 * @module backend/handlers
 */

import type { ConnectionManagerAPI } from './types';
import { DaemonClient } from 'shared';
import { ensureDaemon, stopDaemon, getSockPath } from '../daemon-spawn';
import { createLog, getRegistry } from 'shared';
import { experimentRegistry, applyInitialState } from '../experimental/index';
import {
  initSession as initHumanization,
  destroySession as destroyHumanization,
} from '../experimental/mouse-humanization/index';
import { clearTipCounters } from '../tips';
import { UPGRADE_NOTICE_MESSAGE } from 'shared';

const log = createLog('[Conn]');

// Lazy-load BrowserBridge to break circular dependency (same pattern as backend.ts)
let BrowserBridge: any = null;

async function getBrowserBridge(): Promise<any> {
  if (!BrowserBridge) {
    const mod = await import('../tools');
    BrowserBridge = mod.BrowserBridge;
  }
  return BrowserBridge;
}

// ─── Connect ──────────────────────────────────────────────────

/**
 * Connect to the SuperSurf daemon: validate client_id, spawn daemon if needed,
 * connect via DaemonClient, create BrowserBridge, apply pre-enabled experiments.
 * Transitions state from passive to active.
 */
export async function onConnect(
  mgr: ConnectionManagerAPI,
  args: Record<string, unknown> = {},
  options: { rawResult?: boolean } = {}
): Promise<any> {
  if (
    !args.client_id ||
    typeof args.client_id !== 'string' ||
    (args.client_id as string).trim().length === 0
  ) {
    if (options.rawResult) {
      return { success: false, error: 'missing_client_id', message: 'client_id is required' };
    }
    return {
      content: [
        {
          type: 'text',
          text: `### Missing Required Parameter\n\n\`client_id\` is required.\n\n**Example:**\n\`\`\`\nconnect client_id='my-project'\n\`\`\``,
        },
      ],
      isError: true,
    };
  }

  if (mgr.state !== 'passive') {
    if (options.rawResult) {
      return {
        success: true,
        already_connected: true,
        state: mgr.state,
        browser: mgr.connectedBrowserName,
        client_id: mgr.clientId,
      };
    }
    return {
      content: [
        {
          type: 'text',
          text:
            mgr.statusHeader() +
            `### Already Connected\n\n**State:** ${mgr.state}\n**Client ID:** ${mgr.clientId}\n\nTo restart, call \`disconnect\` first.`,
        },
      ],
    };
  }

  mgr.clientId = (args.client_id as string).trim();
  log('Client ID set to:', mgr.clientId);

  // Start session log file
  const reg = getRegistry();
  if (reg.debugMode) {
    const sessionLogger = reg.setSessionLog(mgr.clientId);
    log('Session log:', sessionLogger.logFilePath);
  }

  // Fresh attempt — clear any stale failure reason from a prior connect.
  mgr.lastConnectError = null;
  mgr.profile = null;

  try {
    const port = mgr.config.port || 5555;

    // Spawn daemon if not running
    log('Ensuring daemon is running...');
    await ensureDaemon(port, mgr.debugMode, mgr.config.enabledExperiments || []);

    // Connect to daemon via Unix socket
    const sockPath = getSockPath();
    let client = new DaemonClient(sockPath, mgr.clientId!);
    await client.start();

    // Refuse to attach to a daemon of a different generation. ensureDaemon
    // only checks PID liveness, so a stale daemon from a previous package
    // version survives upgrades — restart it once with the bundled daemon
    // (owner decision 2026-08-25: daemon lifecycle is server-owned infra,
    // so the restart lives in core, not smart mode).
    let daemonVersion = client.version;
    const serverVersion = mgr.config.server.version;
    if (daemonVersion !== serverVersion) {
      log(`Daemon version mismatch (daemon: ${daemonVersion ?? 'pre-3.0'}, server: ${serverVersion}) — restarting daemon`);
      await client.stop().catch(() => {});
      await stopDaemon();
      await ensureDaemon(port, mgr.debugMode, mgr.config.enabledExperiments || []);
      client = new DaemonClient(sockPath, mgr.clientId!);
      await client.start();
      daemonVersion = client.version;
    }
    if (daemonVersion !== serverVersion) {
      await client.stop().catch(() => {});
      mgr.state = 'passive';
      const hint =
        `A different daemon version is still running after an automatic restart ` +
        `(daemon: ${daemonVersion ?? 'pre-3.0'}, server: ${serverVersion}). ` +
        'Something outside this server keeps respawning it. Restart it manually: ' +
        '`npx supersurf-daemon@latest restart`';
      if (options.rawResult) {
        return { success: false, error: 'version_mismatch', message: hint };
      }
      return {
        content: [{ type: 'text', text: `### Daemon Version Mismatch\n\n${hint}` }],
        isError: true,
      };
    }

    // A version-rejected extension. Without this the session proceeds, the
    // matchmaker refuses every slot, and the agent discovers the problem as a
    // 50s profiles.connect timeout with no cause attached.
    const extensionVersionError = client.extensionVersionError;
    if (extensionVersionError) {
      await client.stop().catch(() => {});
      mgr.state = 'passive';
      if (options.rawResult) {
        return {
          success: false,
          error: 'extension_version_mismatch',
          message: extensionVersionError,
        };
      }
      return {
        content: [
          { type: 'text', text: `### Extension Version Mismatch\n\n${extensionVersionError}` },
        ],
        isError: true,
      };
    }

    mgr.extensionServer = client;

    // Handle extension reconnections — re-query the attached tab so its URL is
    // restored immediately, rather than waiting for the next navigation event.
    // Note: `client` here is always a DaemonClient, and DaemonClient never
    // invokes `onReconnect` (only the legacy bridge.ts ExtensionServer does,
    // on a raw WS reconnect) — so this hook does not currently fire in the
    // live daemon transport. `extensionConnected` intentionally stays
    // whatever it was last set to (seeded false/true at connect, then
    // event-driven by bridge call outcomes) until wired to a real daemon
    // reconnect signal.
    mgr.extensionServer.onReconnect = () => {
      log('Extension reconnected, rehydrating tab state...');
      void rehydrateAttachedTab(mgr, mgr.extensionServer!);
    };

    // Monitor tab info updates
    mgr.extensionServer.onTabInfoUpdate = (tabInfo: any) => {
      log('Tab info update:', tabInfo);
      applyTabInfoUpdate(mgr, tabInfo);
    };

    // Bind experiment registry to daemon transport, keyed by this session's id
    experimentRegistry.bind(mgr.clientId!, client);

    const BB = await getBrowserBridge();
    mgr.bridge = new BB(mgr.config, mgr.extensionServer);
    await mgr.bridge.initialize(mgr.server, mgr.clientInfo, mgr, mgr.metricsLogger);

    mgr.state = 'active';
    mgr.connectedBrowserName = client.browser;
    mgr.extensionConnected = client.extensionConnected;

    // Connect to a managed profile if requested
    if (args.profile && typeof args.profile === 'string') {
      log('Connecting to profile:', args.profile);
      await client.sendCmd('profiles.connect', { profile: args.profile }, 50000);
      mgr.profile = args.profile;
      // profiles.connect resolves only when the matchmaker has a live
      // extension connection for this profile slot.
      mgr.extensionConnected = true;
    }

    // Pre-enable session features from resolved config (fire-and-forget IPC to daemon)
    if (mgr.config.configService) {
      applyInitialState(mgr.clientId!, mgr.config.configService.get().experiments);
    }

    // Mouse humanization keeps per-session cursor + personality state. Create
    // the session here or generateMovement() has nothing to look up and every
    // humanized move silently degrades to a teleport.
    if (experimentRegistry.isEnabled('mouse_humanization', mgr.clientId!)) {
      initHumanization(mgr.clientId!);
    }

    // Notify MCP client that tool list changed
    mgr.notifyToolsListChanged().catch((err: any) =>
      log('Error sending notification:', err)
    );

    // Notify client about experiment configuration path
    mgr.sendLogNotification(
      'info',
      'SuperSurf experiments are toggled via ~/.supersurf/config.json (auto-scaffolded on first daemon start). Restart the daemon after edits.',
      'experiments'
    ).catch(() => {});

    if (options.rawResult) {
      return {
        success: true,
        state: mgr.state,
        browser: mgr.connectedBrowserName,
        client_id: mgr.clientId,
        port,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text:
            mgr.statusHeader() +
            (mgr.config.showUpgradeNotice ? `${UPGRADE_NOTICE_MESSAGE}\n\n` : '') +
            `### Connected to Service\n\n` +
            `**State:** ${mgr.extensionConnected ? 'Active' : 'Active — no extension connected'}\n` +
            `**Browser:** ${mgr.connectedBrowserName}\n\n` +
            (mgr.extensionConnected
              ? ''
              : `⚠️ **No extension connected** — browser tools will fail. Open the SuperSurf popup and click "Enable", or reconnect with \`profile:'<name>'\` to spawn a managed browser.\n\n`) +
            `**Next Steps:**\n` +
            `1. Call \`browser_tabs action='list'\` to see tabs\n` +
            `2. Call \`browser_tabs action='attach' index=N\` to attach\n\n` +
            `**Skill guide:** https://liquidbuiltit.github.io/Supersurf/skill.md`,
        },
      ],
    };
  } catch (error: any) {
    log('Failed to connect:', error);
    mgr.bridge = null;
    if (mgr.extensionServer) {
      await mgr.extensionServer.stop().catch(() => {});
      mgr.extensionServer = null;
    }
    mgr.state = 'passive';
    mgr.profile = null;
    mgr.extensionConnected = false;
    // Remember why, so a follow-up `status` call surfaces the real cause
    // (e.g. wedged-port EADDRINUSE) instead of a bare cached "Disabled".
    mgr.lastConnectError = error.message;

    if (options.rawResult) {
      return {
        success: false,
        error: 'connection_failed',
        message: error.message,
      };
    }

    return {
      content: [{ type: 'text', text: `### Connection Failed\n\n${error.message}` }],
      isError: true,
    };
  }
}

// ─── Tab state ───────────────────────────────────────────────

/**
 * Apply a `tab_info_update` notification to the attached-tab snapshot.
 *
 * A null update clears the tab. A non-null update rebuilds the snapshot **even when
 * `attachedTab` was previously null** — the prior version skipped the update unless a
 * tab was already attached, which left the URL stale/empty after a reconnect (reconnect
 * nulls the tab) and mis-filed fingerprint captures into the 'unknown' bucket. Exported
 * for testing.
 */
export function applyTabInfoUpdate(mgr: ConnectionManagerAPI, tabInfo: any): void {
  if (tabInfo === null) {
    mgr.attachedTab = null;
    return;
  }
  mgr.attachedTab = {
    ...(mgr.attachedTab || {}),
    id: tabInfo.id,
    title: tabInfo.title,
    url: tabInfo.url,
    index: tabInfo.index,
    techStack: tabInfo.techStack || null,
  };
}

/** Minimal daemon-client surface needed to re-query tabs. */
interface TabQueryClient {
  sendCmd: (method: string, params: Record<string, unknown>, timeout?: number) => Promise<unknown>;
}

/**
 * After a reconnect, re-query the extension for the attached tab and repopulate
 * `mgr.attachedTab` (URL included). Without this, the tab stays null until the next
 * navigation fires a `tab_info_update`, so any fingerprint capture in between has no
 * live URL and gets dropped. Best-effort: any failure falls back to null. Exported for testing.
 */
export async function rehydrateAttachedTab(mgr: ConnectionManagerAPI, client: TabQueryClient): Promise<void> {
  try {
    const res: any = await client.sendCmd('getTabs', {}, 10000);
    const tabs: any[] = res?.tabs || [];
    const attached = tabs.find((t) => t.attached);
    mgr.attachedTab = attached
      ? {
          id: attached.id,
          index: attached.index,
          title: attached.title,
          url: attached.url,
          techStack: attached.techStack || null,
        }
      : null;
  } catch {
    mgr.attachedTab = null;
  }
}

// ─── Disconnect ─────────────────────────────────────────────────

/**
 * Disconnect from the daemon: tear down bridge, close DaemonClient session,
 * reset experiments and mouse humanization, transition back to passive.
 * The daemon stays alive for other sessions.
 */
export async function onDisconnect(
  mgr: ConnectionManagerAPI,
  options: { rawResult?: boolean } = {}
): Promise<any> {
  if (mgr.state === 'passive') {
    if (options.rawResult) {
      return { success: true, already_disconnected: true, state: 'passive' };
    }
    return {
      content: [
        {
          type: 'text',
          text:
            mgr.statusHeader() +
            `### Already Disconnected\n\nNot connected to service. Call \`connect\` to activate.`,
        },
      ],
    };
  }

  log('Disconnecting...');

  if (mgr.bridge) {
    mgr.bridge.serverClosed();
    mgr.bridge = null;
  }

  if (mgr.extensionServer) {
    await mgr.extensionServer.stop();
    mgr.extensionServer = null;
  }

  // Close session log, clear tip suppression counters, drop session-scoped
  // experiment + cursor state. All keyed by client_id so a second
  // ConnectionManager in this process keeps its own.
  if (mgr.clientId) {
    getRegistry().clearSessionLog(mgr.clientId);
    clearTipCounters(mgr.clientId);
    experimentRegistry.unbind(mgr.clientId);
    destroyHumanization(mgr.clientId);
  }

  mgr.state = 'passive';
  mgr.connectedBrowserName = null;
  mgr.attachedTab = null;
  mgr.profile = null;
  mgr.extensionConnected = false;

  mgr.notifyToolsListChanged().catch((err: any) =>
    log('Error sending notification:', err)
  );

  if (options.rawResult) {
    return { success: true, state: 'passive' };
  }

  return {
    content: [
      {
        type: 'text',
        text:
          mgr.statusHeader() +
          `### Disconnected from Service\n\nSession closed. Call \`connect\` to reconnect.`,
      },
    ],
  };
}

// ─── Status ──────────────────────────────────────────────────

/** Return current connection state, browser info, and attached tab details. */
export async function onStatus(
  mgr: ConnectionManagerAPI,
  options: { rawResult?: boolean } = {}
): Promise<any> {
  const statusData: Record<string, unknown> = {
    state: mgr.state,
    browser: mgr.connectedBrowserName,
    client_id: mgr.clientId,
    attached_tab: mgr.attachedTab
      ? {
          index: mgr.attachedTab.index,
          title: mgr.attachedTab.title,
          url: mgr.attachedTab.url,
        }
      : null,
  };

  if (options.rawResult) {
    return statusData;
  }

  if (mgr.state === 'passive') {
    return {
      content: [
        {
          type: 'text',
          text:
            mgr.statusHeader() +
            `### Disconnected\n\nNot connected to service. Call \`connect\` to activate.`,
        },
      ],
    };
  }

  let statusText = `### Connected to Service\n\n`;
  if (mgr.connectedBrowserName) {
    statusText += `**Browser:** ${mgr.connectedBrowserName}\n`;
  }

  if (mgr.attachedTab) {
    statusText += `**Tab:** #${mgr.attachedTab.index} — ${mgr.attachedTab.title || 'Untitled'}\n`;
    statusText += `**URL:** ${mgr.attachedTab.url || 'N/A'}\n\n`;
    statusText += `Ready for automation!`;
  } else {
    statusText += `\nNo tab attached. Use \`browser_tabs action='attach' index=N\`.`;
  }

  return {
    content: [{ type: 'text', text: mgr.statusHeader() + statusText }],
  };
}

// ─── Profile Management ──────────────────────────────────────

/** Daemon connection handle used by profile handlers. */
interface DaemonHandle {
  sendCmd: (method: string, params: Record<string, unknown>, timeout?: number) => Promise<unknown>;
}

/**
 * Execute a callback with a daemon connection. Reuses the existing extensionServer
 * if connected, otherwise spawns the daemon (if needed) and creates a temporary
 * DaemonClient for the duration of the call. This lets profile tools work from
 * passive state without a full connect/disconnect cycle.
 */
async function withDaemonConnection(
  mgr: ConnectionManagerAPI,
  fn: (client: DaemonHandle) => Promise<any>
): Promise<any> {
  // Reuse existing connection if available
  if (mgr.extensionServer) {
    return fn({
      sendCmd: (method, params, timeout) => mgr.extensionServer!.sendCmd(method, params, timeout),
    });
  }

  // Create a temporary daemon connection
  await ensureDaemon(mgr.config.port || 5555, mgr.debugMode, mgr.config.enabledExperiments || []);
  const sockPath = getSockPath();
  const tempClient = new DaemonClient(sockPath, `profile-mgmt-${Date.now()}`);
  try {
    await tempClient.start();
    return await fn({
      sendCmd: (method, params, timeout) => tempClient.sendCmd(method, params, timeout),
    });
  } finally {
    await tempClient.stop().catch(() => {});
  }
}

/** Create a new managed Chromium profile. */
export async function onProfileCreate(
  mgr: ConnectionManagerAPI,
  args: Record<string, unknown> = {},
  options: { rawResult?: boolean } = {}
): Promise<any> {
  try {
    return await withDaemonConnection(mgr, async (client) => {
      const result = await client.sendCmd('profiles.create', {
        name: args.name,
        experiments: args.experiments,
      }, 10000);

      if (options.rawResult) return result;
      return {
        content: [{
          type: 'text',
          text: mgr.statusHeader() +
            `### Profile Created\n\n` +
            `**Name:** ${(result as any).profile?.name}\n` +
            `**Created:** ${(result as any).profile?.created}\n\n` +
            `Use \`connect client_id='...' profile='${(result as any).profile?.name}'\` to connect.`,
        }],
      };
    });
  } catch (error: any) {
    if (options.rawResult) return { success: false, error: 'create_failed', message: error.message };
    return { content: [{ type: 'text', text: `### Profile Creation Failed\n\n${error.message}` }], isError: true };
  }
}

/** List all managed Chromium profiles. */
export async function onProfileList(
  mgr: ConnectionManagerAPI,
  options: { rawResult?: boolean } = {}
): Promise<any> {
  try {
    return await withDaemonConnection(mgr, async (client) => {
      const result = await client.sendCmd('profiles.list', {}, 10000);
      if (options.rawResult) return result;

      const profiles = (result as any).profiles || [];
      if (profiles.length === 0) {
        return {
          content: [{
            type: 'text',
            text: mgr.statusHeader() + '### No Profiles\n\nUse `profile_create` to create one.',
          }],
        };
      }

      const lines = profiles.map((p: any) =>
        `- **${p.name}** — created ${p.created}${p.running ? ' (running)' : ''}`
      );
      return {
        content: [{
          type: 'text',
          text: mgr.statusHeader() + `### Profiles (${profiles.length})\n\n${lines.join('\n')}`,
        }],
      };
    });
  } catch (error: any) {
    if (options.rawResult) return { success: false, error: 'list_failed', message: error.message };
    return { content: [{ type: 'text', text: `### Profile List Failed\n\n${error.message}` }], isError: true };
  }
}

/** Delete a managed Chromium profile. */
export async function onProfileDelete(
  mgr: ConnectionManagerAPI,
  args: Record<string, unknown> = {},
  options: { rawResult?: boolean } = {}
): Promise<any> {
  try {
    return await withDaemonConnection(mgr, async (client) => {
      const result = await client.sendCmd('profiles.delete', {
        name: args.name,
      }, 10000);

      if (options.rawResult) return result;
      return {
        content: [{
          type: 'text',
          text: mgr.statusHeader() + `### Profile Deleted\n\nProfile "${args.name}" has been removed.`,
        }],
      };
    });
  } catch (error: any) {
    if (options.rawResult) return { success: false, error: 'delete_failed', message: error.message };
    return { content: [{ type: 'text', text: `### Profile Deletion Failed\n\n${error.message}` }], isError: true };
  }
}

// ─── Reload (debug) ──────────────────────────────────────────

/** Trigger hot reload by exiting with code 42. The debug wrapper catches this and respawns. */
export function onReloadMCP(
  mgr: ConnectionManagerAPI,
  options: { rawResult?: boolean } = {}
): any {
  if (!mgr.debugMode) {
    return {
      content: [{ type: 'text', text: 'reload_mcp only available in debug mode.' }],
      isError: true,
    };
  }

  if (options.rawResult) {
    setTimeout(() => process.exit(42), 100);
    return { success: true, message: 'Reloading...' };
  }

  setTimeout(() => process.exit(42), 100);
  return {
    content: [{ type: 'text', text: 'Reloading MCP server...' }],
  };
}
