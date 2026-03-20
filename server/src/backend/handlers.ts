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
import { DaemonClient } from '../daemon-client';
import { ensureDaemon, getSockPath } from '../daemon-spawn';
import { createLog, getRegistry } from '../logger';
import { experimentRegistry, applyInitialState } from '../experimental/index';
import { initSession as initHumanization, destroySession as destroyHumanization } from '../experimental/mouse-humanization/index';

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

  try {
    const port = mgr.config.port || 5555;

    // Spawn daemon if not running
    log('Ensuring daemon is running...');
    await ensureDaemon(port, mgr.debugMode, mgr.config.enabledExperiments || []);

    // Connect to daemon via Unix socket
    const sockPath = getSockPath();
    const client = new DaemonClient(sockPath, mgr.clientId!);
    await client.start();
    mgr.extensionServer = client;

    // Handle extension reconnections
    mgr.extensionServer.onReconnect = () => {
      log('Extension reconnected, resetting tab state...');
      mgr.attachedTab = null;
    };

    // Monitor tab info updates
    mgr.extensionServer.onTabInfoUpdate = (tabInfo: any) => {
      log('Tab info update:', tabInfo);
      if (tabInfo === null) {
        mgr.attachedTab = null;
        return;
      }
      if (mgr.attachedTab) {
        mgr.attachedTab = {
          ...mgr.attachedTab,
          id: tabInfo.id,
          title: tabInfo.title,
          url: tabInfo.url,
          index: tabInfo.index,
          techStack: tabInfo.techStack || null,
        };
      }
    };

    // Bind experiment registry to daemon transport
    experimentRegistry.bind(client);

    const BB = await getBrowserBridge();
    mgr.bridge = new BB(mgr.config, mgr.extensionServer);
    await mgr.bridge.initialize(mgr.server, mgr.clientInfo, mgr);

    mgr.state = 'active';
    mgr.connectedBrowserName = client.browser;

    // Store daemon capabilities
    mgr.daemonCapabilities = client.capabilities;

    // Connect to a managed profile if requested
    if (args.profile && typeof args.profile === 'string') {
      log('Connecting to profile:', args.profile);
      await client.sendCmd('profiles.connect', { profile: args.profile }, 90000);
    }

    // Pre-enable session features from env var (fire-and-forget IPC to daemon)
    applyInitialState(mgr.config);

    // Notify MCP client that tool list changed
    mgr.notifyToolsListChanged().catch((err: any) =>
      log('Error sending notification:', err)
    );

    // Notify client about available experimental features
    mgr.sendLogNotification(
      'info',
      'SuperSurf experimental features available: page_diffing (reduces token cost by returning DOM diffs instead of full re-reads), smart_waiting (adaptive DOM stability detection), mouse_humanization (human-like cursor trajectories with overshoot correction). ' +
      'Use the experimental_features tool to toggle them, or set SUPERSURF_EXPERIMENTS=page_diffing,smart_waiting,mouse_humanization in your environment to pre-enable on startup.',
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
            `### Connected to Service\n\n` +
            `**State:** Active\n` +
            `**Browser:** ${mgr.connectedBrowserName}\n\n` +
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

  // Close session log
  if (mgr.clientId) {
    getRegistry().clearSessionLog(mgr.clientId);
  }

  mgr.state = 'passive';
  mgr.connectedBrowserName = null;
  mgr.attachedTab = null;
  destroyHumanization('_default');
  experimentRegistry.unbind();

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

// ─── Experimental Features ───────────────────────────────────

/**
 * Toggle experimental features. With no recognized keys, lists current states.
 * For mouse_humanization, also initializes/destroys the humanization session
 * and notifies the extension.
 */
export async function onExperimentalFeatures(
  mgr: ConnectionManagerAPI,
  args: Record<string, unknown> = {},
  options: { rawResult?: boolean } = {}
): Promise<any> {
  const keys = Object.keys(args).filter(k => experimentRegistry.listAvailable().includes(k));

  if (keys.length === 0) {
    const states = experimentRegistry.getStates();
    if (options.rawResult) {
      return { success: true, experiments: states, available: experimentRegistry.listAvailable() };
    }
    return {
      content: [{
        type: 'text',
        text: mgr.statusHeader() +
          `### Experimental Features\n\n` +
          Object.entries(states).map(([k, v]) => `- **${k}**: ${v ? 'enabled' : 'disabled'}`).join('\n') +
          `\n\nPass \`{ "feature_name": true/false }\` to toggle.`,
      }],
    };
  }

  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'boolean') {
      await experimentRegistry.toggle(key, value);
      if (key === 'mouse_humanization') {
        if (value) {
          initHumanization('_default');
          if (mgr.extensionServer) {
            mgr.extensionServer.sendCmd('setHumanizationConfig', { enabled: true }).catch(() => {});
          }
        } else {
          destroyHumanization('_default');
          if (mgr.extensionServer) {
            mgr.extensionServer.sendCmd('setHumanizationConfig', { enabled: false }).catch(() => {});
          }
        }
      }
    }
  }

  const states = experimentRegistry.getStates();
  if (options.rawResult) {
    return { success: true, experiments: states };
  }

  return {
    content: [{
      type: 'text',
      text: mgr.statusHeader() +
        `### Experimental Features Updated\n\n` +
        Object.entries(states).map(([k, v]) => `- **${k}**: ${v ? 'enabled' : 'disabled'}`).join('\n'),
    }],
  };
}

// ─── Profile Management ──────────────────────────────────────

/** Create a new managed Chromium profile. */
export async function onProfileCreate(
  mgr: ConnectionManagerAPI,
  args: Record<string, unknown> = {},
  options: { rawResult?: boolean } = {}
): Promise<any> {
  if (!mgr.extensionServer) {
    const msg = 'Not connected. Call connect first.';
    return options.rawResult
      ? { success: false, error: 'not_connected', message: msg }
      : { content: [{ type: 'text', text: msg }], isError: true };
  }

  try {
    const result = await mgr.extensionServer.sendCmd('profiles.create', {
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
  if (!mgr.extensionServer) {
    const msg = 'Not connected. Call connect first.';
    return options.rawResult
      ? { success: false, error: 'not_connected', message: msg }
      : { content: [{ type: 'text', text: msg }], isError: true };
  }

  try {
    const result = await mgr.extensionServer.sendCmd('profiles.list', {}, 10000);
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
  if (!mgr.extensionServer) {
    const msg = 'Not connected. Call connect first.';
    return options.rawResult
      ? { success: false, error: 'not_connected', message: msg }
      : { content: [{ type: 'text', text: msg }], isError: true };
  }

  try {
    const result = await mgr.extensionServer.sendCmd('profiles.delete', {
      name: args.name,
    }, 10000);

    if (options.rawResult) return result;
    return {
      content: [{
        type: 'text',
        text: mgr.statusHeader() + `### Profile Deleted\n\nProfile "${args.name}" has been removed.`,
      }],
    };
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
