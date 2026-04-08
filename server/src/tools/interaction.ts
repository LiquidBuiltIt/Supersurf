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

/**
 * Pure-JS option matcher used by `select_custom`.
 *
 * Inlined into the page-context eval AND independently unit-tested via
 * `new Function(OPTION_MATCHER_JS + '...')`. Both call sites share the same
 * source string so behavior cannot drift.
 *
 * Match strategy (lowest score = best match):
 *   0 — exact normalized match (whitespace-collapsed, case-insensitive)
 *   1 — alphanumeric-only equality (ignores all spaces/punctuation)
 *   2 — candidate text/value startsWith target
 *   3 — alphanumeric-only startsWith
 *   4 — candidate includes target as substring
 *   5 — alphanumeric-only substring
 *
 * Tie-breaker at the same score: shortest candidate text wins (most specific).
 *
 * Designed to recover from real-world ATS mismatches like
 *   target "United States" vs option "United States +1"
 *   target "United States +1" vs option "United States+1" (no space)
 *
 * Returns the index of the best candidate, or -1 if no match.
 */
export const OPTION_MATCHER_JS = `
function matchOption(target, candidates) {
  if (!target || !candidates || candidates.length === 0) return -1;
  var norm = function (s) { return (s || '').toLowerCase().replace(/\\s+/g, ' ').trim(); };
  var alnum = function (s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
  var t = norm(target);
  var ta = alnum(target);
  if (!t && !ta) return -1;
  var best = -1;
  var bestScore = 999;
  var bestLen = Infinity;
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i] || {};
    var text = norm(c.text);
    var value = norm(c.value);
    var textA = alnum(c.text);
    var valueA = alnum(c.value);
    var score = 999;
    if (t && (text === t || value === t)) score = 0;
    else if (ta && (textA === ta || valueA === ta)) score = 1;
    else if (t && (text.startsWith(t) || value.startsWith(t))) score = 2;
    else if (ta && (textA.startsWith(ta) || valueA.startsWith(ta))) score = 3;
    else if (t && (text.includes(t) || value.includes(t))) score = 4;
    else if (ta && (textA.includes(ta) || valueA.includes(ta))) score = 5;
    var len = (c.text || '').length;
    if (score < bestScore || (score === bestScore && len < bestLen)) {
      bestScore = score;
      best = i;
      bestLen = len;
    }
  }
  return bestScore < 999 ? best : -1;
}
`;

/**
 * Detect tabs spawned by a click action (window.open, target="_blank", etc.).
 * Non-blocking — errors are swallowed so the click response always succeeds.
 */
async function detectSpawnedTabs(ctx: ToolContext, since: number): Promise<string | null> {
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
  const isOnlyScrollActions = actions.every((a: any) =>
    ['scroll_to', 'scroll_by', 'scroll_into_view'].includes(a.type)
  );
  const captureMode = isOnlyScrollActions ? 'viewport' : 'document';
  if (experimentRegistry.isEnabled('page_diffing')) {
    try { beforeState = await ctx.ext.sendCmd('capturePageState', { mode: captureMode }); }
    catch { /* silently skip — extension may not support it yet */ }
  }

  for (const action of actions) {
    try {
      const msg = await executeAction(ctx, action);
      // Handlers may return a message starting with `⚠ ` to signal a soft
      // unverified result (mutation ran but post-action read-back didn't
      // confirm). Strip the marker and use it as the line prefix instead of ✓.
      const isWarn = typeof msg === 'string' && msg.startsWith('⚠ ');
      const body = isWarn ? msg.slice(2) : msg;
      results.push(`${isWarn ? '⚠' : '✓'} ${action.type}: ${body}`);
    } catch (error: any) {
      results.push(`✗ ${action.type}: ${error.message}`);
      if (onError === 'stop') break;
    }
  }

  // === EXPERIMENTAL: page diffing — capture after state and diff ===
  let diffSection = '';
  if (beforeState) {
    try {
      // Let smooth scroll animations settle before capturing viewport
      if (isOnlyScrollActions) await ctx.sleep(350);
      const afterState = await ctx.ext.sendCmd('capturePageState', { mode: captureMode });
      const confidence = calculateConfidence(afterState);
      if (confidence >= 0.5) {
        diffSection = formatDiffSection(diffSnapshots(beforeState, afterState), confidence, afterState, captureMode);
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
      const clickTimestamp = Date.now();
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

      // Detect tab spawns triggered by the click
      const clickLabel = action.selector ?? `(${x}, ${y})`;
      const spawned = await detectSpawnedTabs(ctx, clickTimestamp);
      if (spawned) {
        return `Clicked ${clickLabel} at (${x}, ${y})\n${spawned}`;
      }
      return `Clicked ${clickLabel} at (${x}, ${y})`;
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
      const mcClickTimestamp = Date.now();
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

      // Detect tab spawns triggered by the click
      const mcSpawned = await detectSpawnedTabs(ctx, mcClickTimestamp);
      if (mcSpawned) {
        return `Clicked at (${action.x}, ${action.y})\n${mcSpawned}`;
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

    case 'select_custom': {
      const triggerSelector = action.selector;
      const targetValue = action.value as string;
      if (!triggerSelector) throw new Error('select_custom requires a selector');
      if (!targetValue) throw new Error('select_custom requires a value');

      const expr = ctx.getSelectorExpression(triggerSelector);

      // Step 1: Detect the dropdown trigger element
      const detection = await ctx.eval(`
        (() => {
          const el = ${expr};
          if (!el) return { found: false };

          // Check common custom dropdown patterns
          const isCustomSelect =
            el.getAttribute('role') === 'combobox' ||
            el.getAttribute('role') === 'listbox' ||
            el.getAttribute('aria-haspopup') === 'listbox' ||
            el.getAttribute('aria-haspopup') === 'true' ||
            el.classList.contains('css-1s2u09g-control') || // React Select
            !!el.querySelector('[class*="indicatorContainer"]') || // React Select
            el.getAttribute('data-headlessui-state') !== null ||
            el.getAttribute('data-radix-select-trigger') !== null;

          if (!isCustomSelect) {
            // Fallback: check if any ancestor/sibling looks like a custom select
            const parent = el.closest('[role="combobox"], [role="listbox"], [aria-haspopup="listbox"], [data-headlessui-state], [data-radix-select-trigger]');
            if (!parent) return { found: false };
          }

          return {
            found: true,
            triggerSelector: ${JSON.stringify(triggerSelector)},
            triggerText: el.textContent?.trim().substring(0, 100) || '',
          };
        })()
      `);

      if (!detection?.found) {
        throw new Error(`No custom dropdown trigger found at ${triggerSelector}. Use select_option for native <select> elements.`);
      }

      // Step 2: Snapshot existing options before opening, then click the trigger
      const beforeSnapshot = await ctx.eval(`
        (() => {
          const sels = [
            '[role="option"]', '[role="menuitem"]',
            '[data-headlessui-state] li',
            '[class*="option"]', '[class*="menu"] [class*="option"]',
            '[id*="listbox"] [role="option"]',
            '[id*="react-select"] [id*="option"]',
          ];
          const ids = new Set();
          for (const sel of sels) {
            for (const el of document.querySelectorAll(sel)) {
              ids.add(el.getAttribute('id') || el.textContent?.trim()?.substring(0, 80) || '');
            }
          }
          return [...ids];
        })()
      `) || [];

      const { x, y } = await ctx.getElementCenter(triggerSelector);
      await moveCursorTo(ctx, x, y, '_default');
      await ctx.cdp('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1,
      });
      await ctx.sleep(78 + Math.floor(Math.random() * 64));
      await ctx.cdp('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
      });
      await ctx.eval(`(() => {
        const el = document.elementFromPoint(${x}, ${y});
        if (el) el.click();
      })()`).catch(() => {});

      // Wait for dropdown to render
      await ctx.sleep(300);

      // Step 3: Find and click the target option — only consider options
      // that appeared AFTER the click (scopes to this dropdown, not others)
      const optionResult = await ctx.eval(`
        (() => {
          ${OPTION_MATCHER_JS}
          const target = ${JSON.stringify(targetValue)};
          const beforeIds = new Set(${JSON.stringify(beforeSnapshot)});

          const optionSelectors = [
            '[role="option"]',
            '[role="menuitem"]',
            '[data-headlessui-state] li',
            '[class*="option"]',
            '[class*="menu"] [class*="option"]',
            '[id*="listbox"] [role="option"]',
            '[id*="react-select"] [id*="option"]',
          ];

          // Collect only NEW options (appeared after click)
          const newOptions = [];
          for (const sel of optionSelectors) {
            for (const opt of document.querySelectorAll(sel)) {
              const optId = opt.getAttribute('id') || opt.textContent?.trim()?.substring(0, 80) || '';
              if (!beforeIds.has(optId)) {
                newOptions.push(opt);
              }
            }
          }

          // If no new options appeared, fall back to all options (single dropdown case)
          const candidates = newOptions.length > 0 ? newOptions : (() => {
            const all = [];
            for (const sel of optionSelectors) {
              for (const opt of document.querySelectorAll(sel)) all.push(opt);
            }
            return all;
          })();

          // Build the {text, value} pairs the matcher expects
          const pairs = candidates.map((opt) => ({
            text: opt.textContent?.trim() || '',
            value: opt.getAttribute('data-value') || opt.getAttribute('value') || '',
          }));

          const idx = matchOption(target, pairs);
          if (idx >= 0) {
            const opt = candidates[idx];
            const matched = pairs[idx];
            opt.scrollIntoView({ block: 'nearest' });
            opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            opt.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            opt.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return { found: true, optionText: matched.text || matched.value };
          }

          // Collect available options for error message
          const available = [];
          for (const p of pairs) {
            if (p.text && !available.includes(p.text)) available.push(p.text);
          }
          return { found: false, available: available.slice(0, 20) };
        })()
      `);

      if (!optionResult?.found) {
        const availableMsg = optionResult?.available?.length
          ? ` Available: ${optionResult.available.join(', ')}`
          : '';
        throw new Error(`Option "${targetValue}" not found in dropdown.${availableMsg}`);
      }

      // Brief wait for selection to register
      await ctx.sleep(150);

      // Post-action read-back: confirm the trigger element's visible text changed.
      // React-Select / Headless UI / Radix Select all update the trigger label
      // on selection. If the text is identical to the pre-click snapshot, the
      // click did not propagate to component state — likely a fiber/state issue.
      const verification: any = await ctx.eval(`
        (() => {
          const el = ${expr};
          if (!el) return { verified: false, currentText: '' };
          const currentText = el.textContent?.trim().substring(0, 100) || '';
          const before = ${JSON.stringify(detection.triggerText)};
          return { verified: currentText !== before, currentText };
        })()
      `);

      if (verification?.verified) {
        return `Selected "${optionResult.optionText}" in custom dropdown ${triggerSelector}`;
      }
      return `⚠ Selected "${optionResult.optionText}" in custom dropdown ${triggerSelector} (unverified — trigger text unchanged after option click; the dropdown may not have committed selection state)`;
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

      // Post-action read-back: confirm the input now reports the expected file count.
      // setFileInputFiles is a CDP-only operation that doesn't always fire 'change',
      // so the page-level state (and any React listeners) may not see the upload.
      const verification: any = await ctx.eval(`
        (() => {
          const el = document.querySelector(${JSON.stringify(action.selector)});
          if (!el) return { verified: false, count: 0 };
          const count = el.files ? el.files.length : 0;
          return { verified: count === ${action.files.length}, count };
        })()
      `);

      const expectedCount = action.files.length;
      if (verification?.verified) {
        return `Uploaded ${expectedCount} file(s) to ${action.selector}`;
      }
      return `⚠ Uploaded ${expectedCount} file(s) to ${action.selector} (unverified — input reports ${verification?.count ?? 0} file(s) after upload; the page may not have observed the change)`;
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
