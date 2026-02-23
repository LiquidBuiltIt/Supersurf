/**
 * Connection-level tool handlers — enable, disable, status, experimental features, reload.
 *
 * Each handler receives the ConnectionManagerAPI (mutable state), the tool arguments,
 * and an options object. Handlers return either MCP content responses (for MCP mode)
 * or raw JSON objects (for script mode via `rawResult: true`).
 *
 * State transitions managed here:
 *   - `onEnable`:  passive -> active (starts WebSocket, creates BrowserBridge)
 *   - `onDisable`: active/connected -> passive (tears down everything)
 *   - `onReloadMCP`: triggers exit code 42 for the debug wrapper to restart
 *
 * @module backend/handlers
 */

import type { ConnectionManagerAPI } from './types';
import { ExtensionServer } from '../bridge';
import { createLog, getRegistry } from '../logger';
import { experimentRegistry, isInfraExperimentEnabled, applyInitialState } from '../experimental/index';
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

// ─── Enable ──────────────────────────────────────────────────

/**
 * Activate browser automation: validate client_id, start WebSocket server,
 * create BrowserBridge, apply pre-enabled experiments from env.
 * Transitions state from passive to active.
 */
export async function onEnable(
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
          text: `### ⚠️ Missing Required Parameter\n\n\`client_id\` is required.\n\n**Example:**\n\`\`\`\nenable client_id='my-project'\n\`\`\``,
        },
      ],
      isError: true,
    };
  }

  if (mgr.state !== 'passive') {
    if (options.rawResult) {
      return {
        success: true,
        already_enabled: true,
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
            `### ✅ Already Enabled\n\n**State:** ${mgr.state}\n**Client ID:** ${mgr.clientId}\n\nTo restart, call \`disable\` first.`,
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
    log('Starting extension server...');

    const port = mgr.config.port || 5555;
    if (isInfraExperimentEnabled('multiplexer', mgr.config)) {
      const { Multiplexer } = await import('../experimental/multiplexer');
      mgr.extensionServer = new Multiplexer(port, '127.0.0.1', mgr.clientId!);
    } else {
      mgr.extensionServer = new ExtensionServer(port, '127.0.0.1');
    }
    await mgr.extensionServer.start();

    if (mgr.clientId) {
      mgr.extensionServer.notifyClientId(mgr.clientId);
    }

    // Handle extension reconnections
    mgr.extensionServer.onReconnect = () => {
      log('Extension reconnected, resetting tab state...');
      mgr.attachedTab = null;
      if (mgr.clientId) {
        mgr.extensionServer!.notifyClientId(mgr.clientId);
      }
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

    const BB = await getBrowserBridge();
    mgr.bridge = new BB(mgr.config, mgr.extensionServer);
    await mgr.bridge.initialize(mgr.server, mgr.clientInfo, mgr);

    mgr.state = 'active';
    mgr.connectedBrowserName = 'Local Browser';

    // Pre-enable session features from env var
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
        port: mgr.config.port || 5555,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text:
            mgr.statusHeader() +
            `### ✅ Browser Automation Activated!\n\n` +
            `**State:** Active (waiting for extension)\n` +
            `**Port:** ${port}\n\n` +
            `**Next Steps:**\n` +
            `1. Open the SuperSurf extension popup and enable it\n` +
            `2. Call \`browser_tabs action='list'\` to see tabs\n` +
            `3. Call \`browser_tabs action='attach' index=N\` to attach`,
        },
      ],
    };
  } catch (error: any) {
    log('Failed to start:', error);
    mgr.bridge = null;
    if (mgr.extensionServer) {
      await mgr.extensionServer.stop().catch(() => {});
      mgr.extensionServer = null;
    }
    mgr.state = 'passive';

    const port = mgr.config.port || 5555;
    const isPortError =
      error.message &&
      (error.message.includes('EADDRINUSE') || error.message.includes('address already in use'));

    if (options.rawResult) {
      return {
        success: false,
        error: isPortError ? 'port_in_use' : 'connection_failed',
        message: error.message,
        port,
      };
    }

    const errorMsg = isPortError
      ? `Port ${port} already in use. Disable MCP in other project or use --port <number>.`
      : `### Connection Failed\n\n${error.message}`;

    return { content: [{ type: 'text', text: errorMsg }], isError: true };
  }
}

// ─── Disable ─────────────────────────────────────────────────

/**
 * Deactivate browser automation: tear down bridge, stop WebSocket, reset
 * experiments and mouse humanization, transition back to passive.
 */
export async function onDisable(
  mgr: ConnectionManagerAPI,
  options: { rawResult?: boolean } = {}
): Promise<any> {
  if (mgr.state === 'passive') {
    if (options.rawResult) {
      return { success: true, already_disabled: true, state: 'passive' };
    }
    return {
      content: [
        {
          type: 'text',
          text:
            mgr.statusHeader() +
            `### Already Disabled\n\nCall \`enable\` to activate.`,
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
  experimentRegistry.reset();

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
          `### ✅ Disabled\n\nBrowser automation deactivated. Call \`enable\` to reactivate.`,
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
  const statusData = {
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
            `### ❌ Disabled\n\nBrowser automation is not active. Call \`enable\` to activate.`,
        },
      ],
    };
  }

  let statusText = `### ✅ Enabled\n\n`;
  if (mgr.connectedBrowserName) {
    statusText += `**Browser:** ${mgr.connectedBrowserName}\n`;
  }

  if (mgr.attachedTab) {
    statusText += `**Tab:** #${mgr.attachedTab.index} — ${mgr.attachedTab.title || 'Untitled'}\n`;
    statusText += `**URL:** ${mgr.attachedTab.url || 'N/A'}\n\n`;
    statusText += `✅ Ready for automation!`;
  } else {
    statusText += `\n⚠️ No tab attached. Use \`browser_tabs action='attach' index=N\`.`;
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
    if (value === true) {
      experimentRegistry.enable(key);
      if (key === 'mouse_humanization') {
        initHumanization('_default');
        if (mgr.extensionServer) {
          mgr.extensionServer.sendCmd('setHumanizationConfig', { enabled: true }).catch(() => {});
        }
      }
    } else if (value === false) {
      experimentRegistry.disable(key);
      if (key === 'mouse_humanization') {
        destroyHumanization('_default');
        if (mgr.extensionServer) {
          mgr.extensionServer.sendCmd('setHumanizationConfig', { enabled: false }).catch(() => {});
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
    content: [{ type: 'text', text: '🔄 Reloading MCP server...' }],
  };
}
