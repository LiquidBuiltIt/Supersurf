/**
 * @module experimental/mouse-humanization
 *
 * Extension-side handlers for the mouse humanization experiment.
 * The server generates Bezier waypoint paths; this module replays them
 * via CDP `Input.dispatchMouseEvent`, tracks cursor positions per tab,
 * manages periodic idle drift via Chrome alarms, and provides viewport
 * dimensions so the server can clamp paths to visible bounds.
 *
 * Key exports:
 * - {@link registerMouseHandlers} — registers `humanizedMouseMove`,
 *   `setHumanizationConfig`, and `getViewportDimensions` commands
 * - {@link handleIdleDrift} — alarm callback for idle micro-movements
 */

import type { WebSocketConnection } from '../connection/websocket.js';
import type { SessionContext } from '../session-context.js';

/** A single point along the humanized mouse path, with inter-waypoint delay. */
interface Waypoint {
  x: number;
  y: number;
  /** Milliseconds to wait before dispatching this waypoint's mouseMoved event. */
  delayMs: number;
}

/** Signature for the CDP command dispatcher provided by background.ts. */
type CdpFn = (tabId: number, method: string, params?: any, timeout?: number) => Promise<any>;

/**
 * Register mouse humanization command handlers on the WebSocket connection.
 */
export function registerMouseHandlers(
  wsConnection: WebSocketConnection,
  sessionContext: SessionContext,
  cdp: CdpFn
): void {

  // humanizedMouseMove — replay waypoints via CDP with delays
  wsConnection.registerCommandHandler('humanizedMouseMove', async (params) => {
    const tabId = sessionContext.attachedTabId;
    if (!tabId) throw new Error('No tab attached');

    const waypoints: Waypoint[] = params.waypoints || [];
    if (waypoints.length === 0) {
      return { success: true, waypointCount: 0 };
    }

    for (const wp of waypoints) {
      if (wp.delayMs > 0) {
        await sleep(wp.delayMs);
      }
      await cdp(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: wp.x,
        y: wp.y,
      });
    }

    // Update cursor position in session context
    const last = waypoints[waypoints.length - 1];
    sessionContext.cursorPositions.set(tabId, { x: last.x, y: last.y });
    sessionContext.persistSession();

    return { success: true, waypointCount: waypoints.length };
  });

  // setHumanizationConfig — store config, start/stop idle drift alarms
  wsConnection.registerCommandHandler('setHumanizationConfig', async (params) => {
    sessionContext.humanizationConfig = {
      enabled: !!params.enabled,
    };

    if (params.enabled) {
      // Start idle drift alarm with random interval (10-30s)
      const intervalSec = 10 + Math.random() * 20;
      chrome.alarms.create('mouse-idle-drift', { delayInMinutes: intervalSec / 60 });
    } else {
      // Stop idle drift
      chrome.alarms.clear('mouse-idle-drift');
    }

    return { success: true, enabled: !!params.enabled };
  });

  // getViewportDimensions — returns current viewport size
  wsConnection.registerCommandHandler('getViewportDimensions', async () => {
    const tabId = sessionContext.attachedTabId;
    if (!tabId) throw new Error('No tab attached');

    const result = await cdp(tabId, 'Runtime.evaluate', {
      expression: `JSON.stringify({ width: window.innerWidth, height: window.innerHeight })`,
      returnByValue: true,
    });

    const value = result?.result?.value;
    if (typeof value === 'string') {
      return JSON.parse(value);
    }

    // Fallback dimensions
    return { width: 1920, height: 1080 };
  });
}

/**
 * Handle the mouse-idle-drift alarm.
 * Dispatches a small random drift from the current cursor position.
 * Called from the alarm listener in background.ts.
 */
export async function handleIdleDrift(
  sessionContext: SessionContext,
  cdp: CdpFn
): Promise<void> {
  if (!sessionContext.humanizationConfig.enabled) return;

  const tabId = sessionContext.attachedTabId;
  if (!tabId) return;

  const pos = sessionContext.cursorPositions.get(tabId) || { x: 0, y: 0 };

  // Small random drift: 2-5px in random direction
  const driftMagnitude = 2 + Math.random() * 3;
  const angle = Math.random() * 2 * Math.PI;
  const newX = Math.max(0, Math.round(pos.x + Math.cos(angle) * driftMagnitude));
  const newY = Math.max(0, Math.round(pos.y + Math.sin(angle) * driftMagnitude));

  try {
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: newX,
      y: newY,
    });
    sessionContext.cursorPositions.set(tabId, { x: newX, y: newY });
    sessionContext.persistSession();
  } catch {
    // Silently skip — tab may have been closed
  }

  // Schedule next drift with random interval (10-30s)
  const nextIntervalSec = 10 + Math.random() * 20;
  chrome.alarms.create('mouse-idle-drift', { delayInMinutes: nextIntervalSec / 60 });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
