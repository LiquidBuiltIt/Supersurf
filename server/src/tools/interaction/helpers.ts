// server/src/tools/interaction/helpers.ts
import type { ToolContext } from '../lib/types';
import { experimentRegistry } from '../../experimental/index';
import { generateMovement } from '../../experimental/mouse-humanization/index';
import { createLog } from 'shared';

const log = createLog('[Interact]');

export async function getViewportSize(ctx: ToolContext): Promise<{ width: number; height: number }> {
  return await ctx.ext.sendCmd('getViewportDimensions', { tabId: ctx.tabId });
}

/**
 * Resolve the mouse-humanization session key for a tool call.
 *
 * Keyed by the owning ConnectionManager's `client_id` so two managers in one
 * Node process keep separate cursor state. Falls back to '_default' only for
 * contexts built without a connection manager (unit tests) — BrowserBridge
 * always wires one in production.
 */
export function humanizationSessionId(ctx: ToolContext): string {
  const id = ctx.connectionManager?.clientId;
  return typeof id === 'string' && id.length > 0 ? id : '_default';
}

export async function moveCursorTo(ctx: ToolContext, x: number, y: number): Promise<void> {
  if (experimentRegistry.isEnabled('mouse_humanization')) {
    try {
      const viewport = await getViewportSize(ctx);
      const waypoints = generateMovement(humanizationSessionId(ctx), x, y, viewport);
      log(`Humanized move → (${x},${y}) via ${waypoints.length} waypoints`);
      await ctx.ext.sendCmd('humanizedMouseMove', { waypoints, tabId: ctx.tabId });
      return;
    } catch (e: any) {
      log(`Humanization failed, falling back to teleport:`, e.message);
    }
  }
  log(`Teleport → (${x},${y})`);
  await ctx.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}

export async function detectSpawnedTabs(ctx: ToolContext, since: number): Promise<string | null> {
  try {
    await ctx.sleep(300);
    const result = await ctx.ext.sendCmd('drainSpawnedTabs', { since }, 3000);
    if (result?.tabs?.length > 0) {
      const lines = result.tabs.map((t: any) =>
        `  → Tab #${t.index}: ${t.url || 'about:blank'}${t.title ? ` ("${t.title}")` : ''}`
      );
      return `New tab(s) opened:\n${lines.join('\n')}\nUse browser_tabs action='attach' index=N to switch.`;
    }
  } catch { /* non-blocking */ }
  return null;
}

export const KEY_MAP: Record<string, { key: string; code: string; keyCode: number; text: string }> = {
  Enter:      { key: 'Enter',      code: 'Enter',      keyCode: 13, text: '\r' },
  Tab:        { key: 'Tab',        code: 'Tab',        keyCode: 9,  text: '\t' },
  Escape:     { key: 'Escape',     code: 'Escape',     keyCode: 27, text: '' },
  Backspace:  { key: 'Backspace',  code: 'Backspace',  keyCode: 8,  text: '' },
  Delete:     { key: 'Delete',     code: 'Delete',     keyCode: 46, text: '' },
  ArrowUp:    { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38, text: '' },
  ArrowDown:  { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40, text: '' },
  ArrowLeft:  { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37, text: '' },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, text: '' },
  Space:      { key: ' ',          code: 'Space',      keyCode: 32, text: ' ' },
  Home:       { key: 'Home',       code: 'Home',       keyCode: 36, text: '' },
  End:        { key: 'End',        code: 'End',        keyCode: 35, text: '' },
  PageUp:     { key: 'PageUp',     code: 'PageUp',     keyCode: 33, text: '' },
  PageDown:   { key: 'PageDown',   code: 'PageDown',   keyCode: 34, text: '' },
};
