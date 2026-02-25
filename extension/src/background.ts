/**
 * SuperSurf extension background service worker.
 *
 * Orchestrates the entire extension lifecycle:
 * - Establishes and maintains a WebSocket connection to the local MCP server
 * - Registers ~20 command handlers for browser automation (tabs, navigation, screenshots, etc.)
 * - Manages CDP debugger attachment for network interception, screenshots, and JS evaluation
 * - Integrates domain whitelist enforcement via chrome.webNavigation
 * - Handles auto-reconnect via Chrome alarms (MV3-safe, survives service worker suspension)
 * - Bridges popup UI messages for enable/disable/status queries
 *
 * MV3 constraint: All chrome.* event listeners MUST be registered at the top level
 * (not inside async callbacks) to guarantee the service worker activates on browser events.
 *
 * Adapted from Blueprint MCP (Apache 2.0)
 */

import { Logger } from './utils/logger.js';
import { IconManager } from './utils/icons.js';
import { WebSocketConnection } from './connection/websocket.js';
import { TabHandlers } from './handlers/tabs.js';
import { NetworkTracker } from './handlers/network.js';
import { DialogHandler } from './handlers/dialogs.js';
import { ConsoleHandler } from './handlers/console.js';
import { DownloadHandler } from './handlers/downloads.js';
import { wrapWithUnwrap, shouldUnwrap } from './utils/unwrap.js';
import { secureFill } from './secure-fill.js';
import { ExperimentalFeatures } from './experimental/index.js';
import { waitForDOMStable } from './experimental/wait-for-ready.js';
import { registerMouseHandlers, handleIdleDrift } from './experimental/mouse-humanization.js';
import { registerSecureEvalHandlers } from './experimental/secure-eval/index.js';
import { SessionContext } from './session-context.js';
import { DomainWhitelist } from './domain-whitelist.js';

// chrome.debugger is a reserved word — access via bracket notation
const chromeDebugger = (chrome as any)['debugger'] as ChromeDebugger;

// Top-level variables
let tabHandlers: TabHandlers;
let wsConnection: WebSocketConnection;

// Register lifecycle listeners at TOP LEVEL for MV3 activation guarantee.
// These ensure the service worker activates on first install/sideload and on
// every Chrome launch — without them, the SW may never wake up to establish
// the WebSocket connection to the MCP server.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dist/pages/welcome.html') });
  }
});
(chrome.runtime as any).onStartup.addListener(() => {
  // SW is now active on Chrome launch — same effect
});

// Register tabs.onUpdated at TOP LEVEL for MV3 persistence
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tabHandlers) return;

  const attachedTabId = tabHandlers.getAttachedTabId();
  if (tabId === attachedTabId && changeInfo.url && wsConnection) {
    wsConnection.sendNotification('notifications/tab_info_update', {
      currentTab: {
        id: tab.id,
        title: tab.title,
        url: tab.url,
        index: null,
        techStack: null,
      },
    });
  }
});

// Domain whitelist — initialized in IIFE, referenced by top-level listener
let domainWhitelist: DomainWhitelist | null = null;

// Register webNavigation.onBeforeNavigate at TOP LEVEL for MV3 persistence
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  // Only check top-level navigations on the managed tab
  if (details.frameId !== 0) return;
  if (!domainWhitelist || !tabHandlers) return;

  const attachedTabId = tabHandlers.getAttachedTabId();
  if (details.tabId !== attachedTabId) return;

  if (!domainWhitelist.isDomainAllowed(details.url)) {
    // onBeforeNavigate fires before the navigation commits — the tab is
    // still on the previous page. Navigate back to it to cancel the block.
    try {
      const tab = await chrome.tabs.get(details.tabId);
      await chrome.tabs.update(details.tabId, { url: tab.url || 'about:blank' });
    } catch {
      try {
        await chrome.tabs.update(details.tabId, { url: 'about:blank' });
      } catch { /* last resort, ignore */ }
    }

    // Notify server
    if (wsConnection?.isConnected) {
      wsConnection.sendNotification('notifications/navigation_blocked', {
        url: details.url,
        message: 'Domain not allowed.',
      });
    }
  }
});

// ── Main initialization ──
(async () => {
  const logger = new Logger('SuperSurf');
  await logger.init(chrome);
  const manifest = chrome.runtime.getManifest();
  logger.logAlways(`SuperSurf v${manifest.version}`);

  // Centralized state — rehydrate from chrome.storage.session to survive SW suspension
  const sessionContext = new SessionContext();
  await sessionContext.init(chrome);

  const iconManager = new IconManager(chrome, logger, sessionContext);
  tabHandlers = new TabHandlers(chrome, logger, iconManager, sessionContext);
  const networkTracker = new NetworkTracker(chrome, logger);
  const dialogHandler = new DialogHandler(chrome, logger);
  const consoleHandler = new ConsoleHandler(chrome, logger);
  const downloadHandler = new DownloadHandler(chrome, logger);

  tabHandlers.setConsoleInjector((tabId) => consoleHandler.injectConsoleCapture(tabId));
  tabHandlers.setDialogInjector((tabId) => dialogHandler.setupDialogOverrides(tabId));

  consoleHandler.setupMessageListener();
  iconManager.init();
  networkTracker.init();

  // Domain whitelist
  domainWhitelist = new DomainWhitelist();
  await domainWhitelist.init();

  // State
  let techStackInfo: Record<number, any> = {};
  const cdpNetworkRequests = new Map<string, any>();
  const MAX_CDP_REQUESTS = 500;

  // Keepalive + reconnect alarms
  if (chrome.alarms) {
    // Keepalive fires every minute — always checks connection
    chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
    // Daily whitelist refresh
    chrome.alarms.create('whitelist-refresh', { periodInMinutes: 24 * 60 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === 'keepalive') {
        logger.log('[Background] Keepalive tick, connected=' + wsConnection.isConnected);
        if (!wsConnection.isConnected) {
          logger.log('[Background] Not connected, reconnecting...');
          wsConnection.connect();
        }
      } else if (alarm.name === 'ws-reconnect') {
        logger.log('[Background] Reconnect alarm fired');
        wsConnection.handleReconnectAlarm();
      } else if (alarm.name === 'whitelist-refresh') {
        if (domainWhitelist?.enabled) {
          domainWhitelist.refreshList().catch(() => {});
        }
      } else if (alarm.name === 'mouse-idle-drift') {
        handleIdleDrift(sessionContext, cdp).catch(() => {});
      }
    });
  }

  // CDP debugger events for network tracking.
  // Listens for Network.* and Runtime.* events on the attached tab to build
  // a request log (capped at MAX_CDP_REQUESTS to bound memory).
  chromeDebugger.onEvent.addListener((source, method, params: any) => {
    if (!method.startsWith('Network.') && !method.startsWith('Runtime.')) return;
    if (!sessionContext.currentDebuggerTabId || source.tabId !== sessionContext.currentDebuggerTabId) return;

    try {
      if (method === 'Network.requestWillBeSent') {
        if (cdpNetworkRequests.size >= MAX_CDP_REQUESTS) {
          const oldest = cdpNetworkRequests.keys().next().value;
          if (oldest) cdpNetworkRequests.delete(oldest);
        }
        cdpNetworkRequests.set(params.requestId, {
          requestId: params.requestId,
          url: params.request.url,
          method: params.request.method,
          type: params.type || 'other',
          timestamp: params.wallTime || Date.now() / 1000,
          headers: params.request.headers,
          postData: params.request.postData,
        });
      } else if (method === 'Network.responseReceived') {
        const req = cdpNetworkRequests.get(params.requestId);
        if (req) {
          req.statusCode = params.response.status;
          req.statusText = params.response.statusText;
          req.responseHeaders = params.response.headers;
          req.mimeType = params.response.mimeType;
        }
      } else if (method === 'Network.loadingFinished') {
        const req = cdpNetworkRequests.get(params.requestId);
        if (req) req.completed = true;
      }
    } catch (e) {
      logger.log('[Background] CDP event error:', e);
    }
  });

  chromeDebugger.onDetach.addListener((source) => {
    if (source.tabId === sessionContext.currentDebuggerTabId) {
      sessionContext.debuggerAttached = false;
      sessionContext.currentDebuggerTabId = null;
      logger.log('[Background] Debugger detached');
    }
  });

  // Listen for tech stack info from content script
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message.type === 'techStack' && sender.tab?.id) {
      techStackInfo[sender.tab.id] = message.data;
      tabHandlers.setTechStackInfo(sender.tab.id, message.data);
    }
  });

  /**
   * Attach the CDP debugger to a tab, enabling required domains.
   * If already attached to a different tab, detaches first (single-debugger constraint).
   * Enables Network, DOM, CSS, Runtime, and Page domains for full automation support.
   * @param tabId - The Chrome tab ID to attach the debugger to
   */
  async function ensureDebugger(tabId: number): Promise<void> {
    if (sessionContext.debuggerAttached && sessionContext.currentDebuggerTabId === tabId) return;

    if (sessionContext.debuggerAttached && sessionContext.currentDebuggerTabId !== tabId) {
      try {
        await chromeDebugger.detach({ tabId: sessionContext.currentDebuggerTabId! });
      } catch { /* ignore */ }
    }

    await chromeDebugger.attach({ tabId }, '1.3');
    sessionContext.debuggerAttached = true;
    sessionContext.currentDebuggerTabId = tabId;
    await chromeDebugger.sendCommand({ tabId }, 'Network.enable', {});
    await chromeDebugger.sendCommand({ tabId }, 'DOM.enable', {});
    await chromeDebugger.sendCommand({ tabId }, 'CSS.enable', {});
    await chromeDebugger.sendCommand({ tabId }, 'Runtime.enable', {});
    await chromeDebugger.sendCommand({ tabId }, 'Page.enable', {});
  }

  /**
   * Send a CDP command to a tab with automatic debugger attachment and timeout.
   * Races the CDP call against a timeout to prevent hung commands from blocking the pipeline.
   * @param tabId - Target tab ID
   * @param method - CDP method name (e.g., 'Page.captureScreenshot', 'Runtime.evaluate')
   * @param params - CDP method parameters
   * @param timeout - Max wait in ms before rejecting (default 25s)
   * @returns CDP command result
   */
  async function cdp(tabId: number, method: string, params: any = {}, timeout: number = 25000): Promise<any> {
    await ensureDebugger(tabId);
    return await Promise.race([
      chromeDebugger.sendCommand({ tabId }, method, params),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`CDP timeout: ${method} (${timeout}ms)`)), timeout)
      ),
    ]);
  }

  // ── WebSocket connection ──
  wsConnection = new WebSocketConnection(chrome, logger, iconManager);

  // ── Register command handlers ──
  // Each handler corresponds to a JSON-RPC method the server can invoke.
  // Handlers receive params from the server and return results or throw errors.

  // getTabs
  wsConnection.registerCommandHandler('getTabs', async (params) => {
    return await tabHandlers.getTabs(params);
  });

  // createTab
  wsConnection.registerCommandHandler('createTab', async (params) => {
    return await tabHandlers.createTab(params);
  });

  // selectTab
  wsConnection.registerCommandHandler('selectTab', async (params) => {
    return await tabHandlers.selectTab(params);
  });

  // closeTab
  wsConnection.registerCommandHandler('closeTab', async (params) => {
    return await tabHandlers.closeTab(params);
  });

  // sessionDisconnect — multiplexer signals a session has left
  wsConnection.registerCommandHandler('sessionDisconnect', async (params) => {
    return await tabHandlers.handleSessionDisconnect(params.sessionId);
  });

  // navigate — URL navigation, back/forward history, and reload.
  // When screenshot is requested with a URL navigation, waits for page load
  // completion (via tabs.onUpdated) then optionally applies smart waiting
  // (DOM stability detection) before capturing.
  wsConnection.registerCommandHandler('navigate', async (params) => {
    const tabId = tabHandlers.getAttachedTabId();
    if (!tabId) throw new Error('No tab attached');

    const action = params.action || 'url';
    if (action === 'url') {
      await chrome.tabs.update(tabId, { url: params.url });

      // If screenshot requested, wait for load + capture in one round-trip
      if (params.screenshot) {
        // Wait for tabs.onUpdated status: 'complete'
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 15000);
          const listener = (updatedTabId: number, changeInfo: any) => {
            if (updatedTabId === tabId && changeInfo.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              clearTimeout(timeout);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
        });

        // Smart wait or fixed delay
        if (params.smartWait) {
          try {
            const stabilityMs = params.smartWaitStabilityMs || 500;
            await new Promise(r => setTimeout(r, 500)); // minimum wait
            await chrome.scripting.executeScript({
              target: { tabId },
              func: waitForDOMStable,
              args: [stabilityMs],
            });
          } catch { /* fall through */ }
        } else {
          await new Promise(r => setTimeout(r, 1500));
        }

        // Capture screenshot
        try {
          await ensureDebugger(tabId);
          const screenshotResult = await cdp(tabId, 'Page.captureScreenshot', {
            format: 'jpeg', quality: 70, optimizeForSpeed: true,
          }, 45000);
          return {
            success: true, url: params.url,
            screenshotData: screenshotResult.data,
            screenshotMimeType: 'image/jpeg',
          };
        } catch {
          return { success: true, url: params.url };
        }
      }

      return { success: true, url: params.url };
    } else if (action === 'back') {
      await cdp(tabId, 'Page.navigateToHistoryEntry', { entryId: -1 });
      return { success: true, action: 'back' };
    } else if (action === 'forward') {
      await cdp(tabId, 'Page.navigateToHistoryEntry', { entryId: 1 });
      return { success: true, action: 'forward' };
    } else if (action === 'reload') {
      await chrome.tabs.reload(tabId);
      return { success: true, action: 'reload' };
    }
    return { success: false, error: `Unknown action: ${action}` };
  });

  // forwardCDPCommand — Generic CDP passthrough for server-side tools
  // that need direct CDP access (e.g., CSS inspection, accessibility tree).
  wsConnection.registerCommandHandler('forwardCDPCommand', async (params) => {
    const tabId = tabHandlers.getAttachedTabId();
    if (!tabId) throw new Error('No tab attached');
    return await cdp(tabId, params.method, params.params || {});
  });

  // evaluate — Execute JavaScript in the page via CDP Runtime.evaluate.
  // Supports two code paths: pre-wrapped (from secure_eval Layer 3, which uses
  // `with` statements requiring sloppy mode) and normal (prefixed with 'use strict').
  // Bot-detection bypass: shouldUnwrap/wrapWithUnwrap temporarily restores native
  // DOM methods that pages may have overridden to detect automation.
  wsConnection.registerCommandHandler('evaluate', async (params) => {
    const tabId = tabHandlers.getAttachedTabId();
    if (!tabId) throw new Error('No tab attached');

    const code = params.function || params.expression || '';

    let expression: string;
    if (params.prewrapped) {
      // Code is already wrapped by secure_eval Layer 3 — don't add strict prefix
      // (the wrapper has its own strict inner IIFE, and the sloppy outer MUST NOT
      // be strict or `with` is a SyntaxError)
      const wrapped = shouldUnwrap(code) ? wrapWithUnwrap(code) : code;
      expression = wrapped;
    } else {
      const wrapped = shouldUnwrap(code) ? wrapWithUnwrap(code) : code;
      expression = `'use strict';\n${wrapped}`;
    }

    const result = await cdp(tabId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });

    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const message = details.exception?.description
        || details.text
        || details.exception?.className
        || 'JavaScript execution error';
      throw new Error(message);
    }

    return result.result?.value;
  });

  // snapshot (accessible DOM)
  wsConnection.registerCommandHandler('snapshot', async () => {
    const tabId = tabHandlers.getAttachedTabId();
    if (!tabId) throw new Error('No tab attached');
    return await cdp(tabId, 'Accessibility.getFullAXTree', {});
  });

  // screenshot
  wsConnection.registerCommandHandler('screenshot', async (params) => {
    const tabId = tabHandlers.getAttachedTabId();
    if (!tabId) throw new Error('No tab attached');

    const captureParams: any = {
      format: params.type || 'jpeg',
      quality: params.quality || 70,
      optimizeForSpeed: true,
    };
    if (params.clip_x !== undefined) {
      captureParams.clip = {
        x: params.clip_x, y: params.clip_y,
        width: params.clip_width, height: params.clip_height,
        scale: 1,
      };
    }

    const result = await cdp(tabId, 'Page.captureScreenshot', captureParams, 45000);
    return { data: result.data, mimeType: `image/${params.type || 'jpeg'}` };
  });

  // consoleMessages
  wsConnection.registerCommandHandler('consoleMessages', async (params) => {
    const tabId = tabHandlers.getAttachedTabId();
    return { messages: consoleHandler.getMessages(tabId || undefined) };
  });

  // networkRequests
  wsConnection.registerCommandHandler('networkRequests', async (params) => {
    return { requests: networkTracker.getRequests() };
  });

  // clearNetwork
  wsConnection.registerCommandHandler('clearNetwork', async () => {
    networkTracker.clearRequests();
    cdpNetworkRequests.clear();
    return { success: true };
  });

  // dialog
  wsConnection.registerCommandHandler('dialog', async (params) => {
    const tabId = tabHandlers.getAttachedTabId();
    if (!tabId) throw new Error('No tab attached');

    if (params.accept !== undefined) {
      await dialogHandler.setupDialogOverrides(tabId, params.accept, params.text);
      return { success: true };
    }

    return { events: await dialogHandler.getDialogEvents(tabId) };
  });

  // window management
  wsConnection.registerCommandHandler('window', async (params) => {
    const tabId = tabHandlers.getAttachedTabId();
    if (!tabId) throw new Error('No tab attached');

    const tab = await chrome.tabs.get(tabId);
    const windowId = tab.windowId;

    switch (params.action) {
      case 'resize':
        await chrome.windows.update(windowId, { width: params.width, height: params.height });
        return { success: true };
      case 'minimize':
        await chrome.windows.update(windowId, { state: 'minimized' });
        return { success: true };
      case 'maximize':
        await chrome.windows.update(windowId, { state: 'maximized' });
        return { success: true };
      case 'close':
        await chrome.windows.remove(windowId);
        return { success: true };
      default:
        throw new Error(`Unknown window action: ${params.action}`);
    }
  });

  // extensions
  wsConnection.registerCommandHandler('listExtensions', async () => {
    const extensions = await chrome.management.getAll();
    return { extensions: extensions.map((e) => ({ id: e.id, name: e.name, enabled: e.enabled, type: e.type })) };
  });

  wsConnection.registerCommandHandler('reloadExtension', async (params) => {
    const extensions = await chrome.management.getAll();
    const ext = extensions.find((e) =>
      e.name.toLowerCase().includes((params.extensionName || '').toLowerCase()) &&
      e.installType === 'development'
    );
    if (!ext) throw new Error('Extension not found or not unpacked');
    await chrome.management.setEnabled(ext.id, false);
    await chrome.management.setEnabled(ext.id, true);
    return { success: true, name: ext.name };
  });

  // performance metrics
  wsConnection.registerCommandHandler('performanceMetrics', async () => {
    const tabId = tabHandlers.getAttachedTabId();
    if (!tabId) throw new Error('No tab attached');
    const result = await cdp(tabId, 'Performance.getMetrics', {});
    return { metrics: result.metrics };
  });

  // download
  wsConnection.registerCommandHandler('download', async (params) => {
    return await downloadHandler.download(params);
  });

  // secure_fill — Inject credentials into form fields without exposing values to the agent.
  // Runs in MAIN world (not isolated) so it can interact with page-level input frameworks.
  // Types character-by-character with randomized delays to mimic human input.
  wsConnection.registerCommandHandler('secure_fill', async (params) => {
    const tabId = tabHandlers.getAttachedTabId();
    if (!tabId) throw new Error('No tab attached');

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN' as any,
      func: (selector: string, value: string) => {
        // Inline secure fill logic for MAIN world execution
        return new Promise<{ success: boolean; error?: string }>((resolve) => {
          const el = document.querySelector(selector) as HTMLInputElement | null;
          if (!el) {
            resolve({ success: false, error: `Element not found: ${selector}` });
            return;
          }

          el.focus();
          el.dispatchEvent(new Event('focus', { bubbles: true }));
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));

          let i = 0;
          const chars = value.split('');
          function typeNext() {
            if (i >= chars.length) {
              el!.dispatchEvent(new Event('change', { bubbles: true }));
              resolve({ success: true });
              return;
            }
            const char = chars[i++];
            el!.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
            el!.value += char;
            el!.dispatchEvent(new Event('input', { bubbles: true }));
            el!.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
            setTimeout(typeNext, 40 + Math.random() * 80);
          }
          typeNext();
        });
      },
      args: [params.selector, params.value],
    });

    return results?.[0]?.result || { success: false, error: 'Script execution failed' };
  });

  // ── Experimental feature handlers ──
  ExperimentalFeatures.registerHandlers(wsConnection, tabHandlers, networkTracker, sessionContext);
  registerMouseHandlers(wsConnection, sessionContext, cdp);
  registerSecureEvalHandlers(wsConnection);

  // ── Popup message handler ──
  // Handles messages from the extension popup UI (enable/disable, status queries,
  // whitelist toggling). Each handler returns true to indicate async sendResponse.
  chrome.runtime.onMessage.addListener((message: any, _sender: any, sendResponse: any) => {
    if (message.type === 'getStatus') {
      const attachedTabId = tabHandlers.getAttachedTabId();
      sendResponse({
        connected: wsConnection.isConnected,
        currentTabConnected: attachedTabId !== null,
        stealthMode: null,
        projectName: wsConnection.projectName,
      });
      return true;
    }
    if (message.type === 'enableExtension') {
      chrome.storage.local.set({ extensionEnabled: true });
      if (!wsConnection.isConnected) wsConnection.connect();
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'disableExtension') {
      chrome.storage.local.set({ extensionEnabled: false });
      wsConnection.disconnect();
      sessionContext.clearStorage();
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'enableWhitelist') {
      domainWhitelist?.enable().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (message.type === 'disableWhitelist') {
      domainWhitelist?.disable().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (message.type === 'getWhitelistStats') {
      sendResponse(domainWhitelist?.getStats() || { enabled: false, domainCount: 0, lastFetch: 0 });
      return true;
    }
    return false;
  });

  // ── Connect ──
  await wsConnection.connect();

  logger.logAlways('SuperSurf background initialized');
})();
