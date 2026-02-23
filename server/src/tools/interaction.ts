/**
 * Interaction tool handlers — click, type, scroll, hover, etc.
 *
 * Handles the `browser_interact` tool which accepts an ordered array of
 * actions and executes them sequentially. Integrates with two experimental
 * features: page_diffing (captures DOM before/after and returns a diff)
 * and mouse_humanization (generates Bezier-curve mouse paths).
 *
 * All mouse interactions go through CDP `Input.dispatch*` events with
 * realistic timing based on the Balabit Mouse Dynamics dataset.
 *
 * @module tools/interaction
 */

import type { ToolContext } from './types';
import { experimentRegistry, diffSnapshots, calculateConfidence, formatDiffSection } from '../experimental/index';
import { generateMovement } from '../experimental/mouse-humanization/index';
import { createLog } from '../logger';

const log = createLog('[Interact]');

/** Maps friendly key names to CDP Input.dispatchKeyEvent parameters. */
const KEY_MAP: Record<string, { key: string; code: string; keyCode: number; text: string }> = {
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

/**
 * Execute a sequence of page interactions (click, type, hover, scroll, etc.).
 *
 * Optionally captures DOM state before/after for page diffing, and returns
 * per-action success/failure results. The `onError` arg controls whether
 * the sequence stops on first failure or continues.
 *
 * @param ctx - Tool context with CDP/eval/extension access
 * @param args - `{ actions: Action[], onError?: 'stop'|'ignore', screenshot?: boolean }`
 * @param options - `{ rawResult?: boolean }`
 */
export async function onInteract(ctx: ToolContext, args: any, options: any): Promise<any> {
  const actions = args.actions as any[];
  const onError = (args.onError as string) || 'stop';
  const results: string[] = [];

  // === EXPERIMENTAL: page diffing — capture before state ===
  let beforeState: any = null;
  if (experimentRegistry.isEnabled('page_diffing')) {
    try { beforeState = await ctx.ext.sendCmd('capturePageState', {}); }
    catch { /* silently skip — extension may not support it yet */ }
  }

  for (const action of actions) {
    try {
      const msg = await executeAction(ctx, action);
      results.push(`✓ ${action.type}: ${msg}`);
    } catch (error: any) {
      results.push(`✗ ${action.type}: ${error.message}`);
      if (onError === 'stop') break;
    }
  }

  // === EXPERIMENTAL: page diffing — capture after state and diff ===
  let diffSection = '';
  if (beforeState) {
    try {
      const afterState = await ctx.ext.sendCmd('capturePageState', {});
      const confidence = calculateConfidence(afterState);
      if (confidence >= 0.5) {
        diffSection = formatDiffSection(diffSnapshots(beforeState, afterState), confidence, afterState);
      } else {
        diffSection = `\n\n---\n**Page diff:** confidence below threshold (${Math.round(confidence * 100)}%) — full re-read recommended`;
      }
    } catch { /* silently skip */ }
  }

  if (options.rawResult) {
    return { success: !results.some(r => r.startsWith('✗')), actions: results };
  }

  return {
    content: [{ type: 'text', text: results.join('\n') + diffSection }],
    isError: results.some(r => r.startsWith('✗')),
  };
}

/** Get viewport dimensions from extension */
async function getViewportSize(ctx: ToolContext): Promise<{ width: number; height: number }> {
  return await ctx.ext.sendCmd('getViewportDimensions', {});
}

/** Move cursor to (x, y) using humanized path or direct CDP */
async function moveCursorTo(ctx: ToolContext, x: number, y: number, sessionId: string): Promise<void> {
  if (experimentRegistry.isEnabled('mouse_humanization')) {
    try {
      const viewport = await getViewportSize(ctx);
      const waypoints = generateMovement(sessionId, x, y, viewport);
      log(`Humanized move → (${x},${y}) via ${waypoints.length} waypoints`);
      await ctx.ext.sendCmd('humanizedMouseMove', { waypoints });
      return;
    } catch (e: any) {
      log(`Humanization failed, falling back to teleport:`, e.message);
    }
  }
  log(`Teleport → (${x},${y})`);
  await ctx.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}

/**
 * Execute a single interaction action and return a human-readable result string.
 * Throws on failure so the caller can format error messages.
 */
async function executeAction(ctx: ToolContext, action: any): Promise<string> {
  switch (action.type) {
    case 'click': {
      let x: number, y: number;
      if (action.selector) {
        ({ x, y } = await ctx.getElementCenter(action.selector));
      } else if (action.x !== undefined && action.y !== undefined) {
        x = action.x;
        y = action.y;
      } else {
        throw new Error('Click requires either a selector or x/y coordinates');
      }
      const button = action.button || 'left';
      const clickCount = action.clickCount || 1;

      await moveCursorTo(ctx, x, y, '_default');
      await ctx.cdp('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button, clickCount, buttons: 1,
      });
      // Human click hold: 78-141ms, median ~109ms (Balabit Mouse Dynamics dataset)
      await ctx.sleep(78 + Math.floor(Math.random() * 64));
      await ctx.cdp('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button, clickCount,
      });

      // Dispatch DOM-level click for navigation (CDP mouse events don't synthesize click)
      await ctx.eval(`(() => {
        const el = document.elementFromPoint(${x}, ${y});
        if (el && (el.closest('a[href]') || el.onclick)) el.click();
      })()`).catch(() => {});

      // === EXPERIMENTAL: post-click smart waiting ===
      if (experimentRegistry.isEnabled('smart_waiting')) {
        try { await ctx.ext.sendCmd('waitForReady', { timeout: 3000, stabilityMs: 300 }); }
        catch { /* non-blocking — click may not trigger navigation */ }
      }

      return `Clicked ${action.selector ?? `(${x}, ${y})`} at (${x}, ${y})`;
    }

    case 'type': {
      if (action.selector) {
        const expr = ctx.getSelectorExpression(action.selector);
        await ctx.eval(`(() => { const el = ${expr}; if (el) el.focus(); })()`);
      }

      for (const char of action.text) {
        await ctx.cdp('Input.dispatchKeyEvent', { type: 'char', text: char });
      }

      if (action.selector) {
        const expr = ctx.getSelectorExpression(action.selector);
        const finalValue = await ctx.eval(`(() => { const el = ${expr}; return el?.value; })()`);
        return `Typed "${action.text}" into ${action.selector} (value: "${finalValue ?? 'N/A'}")`;
      }
      return `Typed "${action.text}" into focused element`;
    }

    case 'clear': {
      const expr = ctx.getSelectorExpression(action.selector);
      await ctx.eval(`
        (() => {
          const el = ${expr};
          if (!el) throw new Error('Element not found');
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        })()
      `);
      return `Cleared ${action.selector}`;
    }

    case 'press_key': {
      const key = action.key;
      const mapped = KEY_MAP[key];
      const keyCode = mapped?.keyCode || 0;
      const text = mapped?.text || (key.length === 1 ? key : '');

      const params = {
        key, code: mapped?.code || key,
        windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
        text, unmodifiedText: text,
      };

      await ctx.cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
      await ctx.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
      return `Pressed ${key}`;
    }

    case 'hover': {
      const { x, y } = await ctx.getElementCenter(action.selector);
      await moveCursorTo(ctx, x, y, '_default');
      return `Hovered ${action.selector} at (${x}, ${y})`;
    }

    case 'wait': {
      const timeout = action.timeout || 30000;
      if (action.selector) {
        await ctx.eval(`
          new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout waiting for element')), ${timeout});
            const check = () => {
              if (document.querySelector(${JSON.stringify(action.selector)})) {
                clearTimeout(timeout);
                resolve(true);
              } else {
                setTimeout(check, 100);
              }
            };
            check();
          })
        `);
        return `Element appeared: ${action.selector}`;
      } else {
        await ctx.sleep(timeout);
        return `Waited ${timeout}ms`;
      }
    }

    case 'mouse_move': {
      await moveCursorTo(ctx, action.x, action.y, '_default');
      return `Moved to (${action.x}, ${action.y})`;
    }

    case 'mouse_click': {
      const button = action.button || 'left';
      const clickCount = action.clickCount || 1;
      await moveCursorTo(ctx, action.x, action.y, '_default');
      await ctx.cdp('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: action.x, y: action.y, button, clickCount, buttons: 1,
      });
      await ctx.sleep(78 + Math.floor(Math.random() * 64));
      await ctx.cdp('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: action.x, y: action.y, button, clickCount,
      });

      // Dispatch DOM-level click for navigation (CDP mouse events don't synthesize click)
      await ctx.eval(`(() => {
        const el = document.elementFromPoint(${action.x}, ${action.y});
        if (el && (el.closest('a[href]') || el.onclick)) el.click();
      })()`).catch(() => {});

      // === EXPERIMENTAL: post-click smart waiting ===
      if (experimentRegistry.isEnabled('smart_waiting')) {
        try { await ctx.ext.sendCmd('waitForReady', { timeout: 3000, stabilityMs: 300 }); }
        catch { /* non-blocking — click may not trigger navigation */ }
      }

      return `Clicked at (${action.x}, ${action.y})`;
    }

    case 'scroll_to': {
      if (action.selector) {
        const expr = ctx.getSelectorExpression(action.selector);
        await ctx.eval(`(() => { const el = ${expr}; if (el) el.scrollTo(${action.x || 0}, ${action.y || 0}); })()`);
        return `Scrolled ${action.selector} to (${action.x || 0}, ${action.y || 0})`;
      }
      await ctx.eval(`window.scrollTo(${action.x || 0}, ${action.y || 0})`);
      return `Scrolled window to (${action.x || 0}, ${action.y || 0})`;
    }

    case 'scroll_by': {
      if (action.selector) {
        const expr = ctx.getSelectorExpression(action.selector);
        await ctx.eval(`(() => { const el = ${expr}; if (el) el.scrollBy(${action.x || 0}, ${action.y || 0}); })()`);
        return `Scrolled ${action.selector} by (${action.x || 0}, ${action.y || 0})`;
      }
      await ctx.eval(`window.scrollBy(${action.x || 0}, ${action.y || 0})`);
      return `Scrolled window by (${action.x || 0}, ${action.y || 0})`;
    }

    case 'scroll_into_view': {
      const expr = ctx.getSelectorExpression(action.selector);
      await ctx.eval(`
        (() => {
          const el = ${expr};
          if (!el) throw new Error('Element not found');
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        })()
      `);
      return `Scrolled ${action.selector} into view`;
    }

    case 'select_option': {
      const expr = ctx.getSelectorExpression(action.selector);
      const result = await ctx.eval(`
        (() => {
          const el = ${expr};
          if (!el || el.tagName !== 'SELECT') throw new Error('Not a <select> element');
          const options = Array.from(el.options);
          const target = ${JSON.stringify(action.value)};

          // Match by value first, then by text
          let opt = options.find(o => o.value === target);
          if (!opt) opt = options.find(o => o.textContent?.trim().toLowerCase() === target.toLowerCase());
          if (!opt) throw new Error('Option not found: ' + target);

          // Use native setter to bypass frameworks
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
          if (nativeSetter) nativeSetter.call(el, opt.value);
          else el.value = opt.value;

          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return opt.textContent?.trim() || opt.value;
        })()
      `);
      return `Selected "${result}" in ${action.selector}`;
    }

    case 'file_upload': {
      const evalResult = await ctx.cdp('Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(action.selector)})`,
        returnByValue: false,
      });
      if (!evalResult.result?.objectId) throw new Error(`Element not found: ${action.selector}`);

      const nodeResult = await ctx.cdp('DOM.describeNode', { objectId: evalResult.result.objectId });
      await ctx.cdp('DOM.setFileInputFiles', {
        files: action.files,
        backendNodeId: nodeResult.node.backendNodeId,
      });
      return `Uploaded ${action.files.length} file(s) to ${action.selector}`;
    }

    case 'force_pseudo_state': {
      const pseudoStates = action.pseudoStates || [];
      const doc = await ctx.cdp('DOM.getDocument', {});
      const nodeResult = await ctx.cdp('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: action.selector,
      });
      if (!nodeResult.nodeId) throw new Error(`Element not found: ${action.selector}`);

      await ctx.cdp('CSS.forcePseudoState', {
        nodeId: nodeResult.nodeId,
        forcedPseudoClasses: pseudoStates,
      });
      return `Forced pseudo-states [${pseudoStates.join(', ')}] on ${action.selector}`;
    }

    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }
}
