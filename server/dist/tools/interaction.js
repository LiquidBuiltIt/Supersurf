"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.onInteract = onInteract;
const frames_1 = require("./frames");
const index_1 = require("../experimental/index");
const index_2 = require("../experimental/mouse-humanization/index");
const logger_1 = require("../logger");
const option_matcher_1 = require("./option-matcher");
const log = (0, logger_1.createLog)('[Interact]');
/**
 * Detect tabs spawned by a click action (window.open, target="_blank", etc.).
 * Non-blocking — errors are swallowed so the click response always succeeds.
 */
async function detectSpawnedTabs(ctx, since) {
    try {
        await ctx.sleep(300);
        const result = await ctx.ext.sendCmd('drainSpawnedTabs', { since }, 3000);
        if (result?.tabs?.length > 0) {
            const lines = result.tabs.map((t) => `  → Tab #${t.index}: ${t.url || 'about:blank'}${t.title ? ` ("${t.title}")` : ''}`);
            return `New tab(s) opened:\n${lines.join('\n')}\nUse browser_tabs action='attach' index=N to switch.`;
        }
    }
    catch { /* non-blocking */ }
    return null;
}
/** Maps friendly key names to CDP Input.dispatchKeyEvent parameters. */
const KEY_MAP = {
    Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
    Escape: { key: 'Escape', code: 'Escape', keyCode: 27, text: '' },
    Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8, text: '' },
    Delete: { key: 'Delete', code: 'Delete', keyCode: 46, text: '' },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, text: '' },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, text: '' },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, text: '' },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, text: '' },
    Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
    Home: { key: 'Home', code: 'Home', keyCode: 36, text: '' },
    End: { key: 'End', code: 'End', keyCode: 35, text: '' },
    PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33, text: '' },
    PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34, text: '' },
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
async function onInteract(ctx, args, options) {
    const actions = args.actions;
    const onError = args.onError || 'stop';
    const results = [];
    // === EXPERIMENTAL: page diffing — capture before state ===
    let beforeState = null;
    const isOnlyScrollActions = actions.every((a) => ['scroll_to', 'scroll_by', 'scroll_into_view'].includes(a.type));
    const captureMode = isOnlyScrollActions ? 'viewport' : 'document';
    if (index_1.experimentRegistry.isEnabled('page_diffing')) {
        try {
            beforeState = await ctx.ext.sendCmd('capturePageState', { mode: captureMode });
        }
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
        }
        catch (error) {
            results.push(`✗ ${action.type}: ${error.message}`);
            if (onError === 'stop')
                break;
        }
    }
    // === EXPERIMENTAL: page diffing — capture after state and diff ===
    let diffSection = '';
    if (beforeState) {
        try {
            // Let smooth scroll animations settle before capturing viewport
            if (isOnlyScrollActions)
                await ctx.sleep(350);
            const afterState = await ctx.ext.sendCmd('capturePageState', { mode: captureMode });
            const confidence = (0, index_1.calculateConfidence)(afterState);
            if (confidence >= 0.5) {
                diffSection = (0, index_1.formatDiffSection)((0, index_1.diffSnapshots)(beforeState, afterState), confidence, afterState, captureMode);
            }
            else {
                diffSection = `\n\n---\n**Page diff:** confidence below threshold (${Math.round(confidence * 100)}%) — full re-read recommended`;
            }
        }
        catch { /* silently skip */ }
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
async function getViewportSize(ctx) {
    return await ctx.ext.sendCmd('getViewportDimensions', {});
}
/** Move cursor to (x, y) using humanized path or direct CDP */
async function moveCursorTo(ctx, x, y, sessionId) {
    if (index_1.experimentRegistry.isEnabled('mouse_humanization')) {
        try {
            const viewport = await getViewportSize(ctx);
            const waypoints = (0, index_2.generateMovement)(sessionId, x, y, viewport);
            log(`Humanized move → (${x},${y}) via ${waypoints.length} waypoints`);
            await ctx.ext.sendCmd('humanizedMouseMove', { waypoints });
            return;
        }
        catch (e) {
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
async function executeAction(ctx, action) {
    switch (action.type) {
        case 'click': {
            const clickTimestamp = Date.now();
            let x, y;
            let clickContextId = null;
            if (action.selector) {
                const c = await (0, frames_1.getCenterInFrame)(ctx, action.selector);
                x = c.x;
                y = c.y;
                clickContextId = c.contextId;
            }
            else if (action.x !== undefined && action.y !== undefined) {
                x = action.x;
                y = action.y;
            }
            else {
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
            // Dispatch DOM-level click for navigation (CDP mouse events don't synthesize click).
            // Must run in the frame that owns the element so elementFromPoint resolves inside the iframe.
            const domClickExpr = `(() => {
        const el = document.elementFromPoint(${x}, ${y});
        if (el && (el.closest('a[href]') || el.onclick)) el.click();
      })()`;
            await (0, frames_1.evalInFrameOrTop)(ctx, domClickExpr, clickContextId).catch(() => { });
            // === EXPERIMENTAL: post-click smart waiting ===
            if (index_1.experimentRegistry.isEnabled('smart_waiting')) {
                try {
                    await ctx.ext.sendCmd('waitForReady', { timeout: 3000, stabilityMs: 300 });
                }
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
            let typeContextId = null;
            if (action.selector) {
                const selectorExpr = ctx.getSelectorExpression(action.selector);
                const match = await (0, frames_1.resolveInFrames)(ctx, selectorExpr);
                if (!match)
                    throw new Error(`Element not found: ${action.selector}`);
                typeContextId = match.contextId;
                const focusExpr = `
          (() => {
            const el = ${selectorExpr};
            if (!el) return { focused: false };
            el.focus();
            return { focused: document.activeElement === el };
          })()
        `;
                const focusResult = await (0, frames_1.evalInFrameOrTop)(ctx, focusExpr, typeContextId);
                if (!focusResult?.focused)
                    throw new Error(`Failed to focus ${action.selector}`);
            }
            for (const char of action.text) {
                await ctx.cdp('Input.dispatchKeyEvent', { type: 'char', text: char });
            }
            if (action.selector) {
                const selectorExpr = ctx.getSelectorExpression(action.selector);
                const readExpr = `(() => { const el = ${selectorExpr}; return el?.value; })()`;
                const finalValue = await (0, frames_1.evalInFrameOrTop)(ctx, readExpr, typeContextId);
                return `Typed "${action.text}" into ${action.selector} (value: "${finalValue ?? 'N/A'}")`;
            }
            return `Typed "${action.text}" into focused element`;
        }
        case 'clear': {
            const selectorExpr = ctx.getSelectorExpression(action.selector);
            const match = await (0, frames_1.resolveInFrames)(ctx, selectorExpr);
            if (!match)
                throw new Error(`Element not found: ${action.selector}`);
            const clearExpr = `
        (() => {
          const el = ${selectorExpr};
          if (!el) return { cleared: false };
          el.focus();
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { cleared: true };
        })()
      `;
            const result = await (0, frames_1.evalInFrameOrTop)(ctx, clearExpr, match.contextId);
            if (!result?.cleared)
                throw new Error(`Failed to clear ${action.selector}`);
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
            const { x, y } = await (0, frames_1.getCenterInFrame)(ctx, action.selector);
            await moveCursorTo(ctx, x, y, '_default');
            return `Hovered ${action.selector} at (${x}, ${y})`;
        }
        case 'wait': {
            const timeout = action.timeout || 30000;
            if (action.selector) {
                const selectorExpr = ctx.getSelectorExpression(action.selector);
                const deadline = Date.now() + timeout;
                while (Date.now() < deadline) {
                    const match = await (0, frames_1.resolveInFrames)(ctx, selectorExpr);
                    if (match)
                        return `Element appeared: ${action.selector}`;
                    await ctx.sleep(100);
                }
                throw new Error(`Timeout waiting for element: ${action.selector}`);
            }
            else {
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
      })()`).catch(() => { });
            // === EXPERIMENTAL: post-click smart waiting ===
            if (index_1.experimentRegistry.isEnabled('smart_waiting')) {
                try {
                    await ctx.ext.sendCmd('waitForReady', { timeout: 3000, stabilityMs: 300 });
                }
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
                const selectorExpr = ctx.getSelectorExpression(action.selector);
                const match = await (0, frames_1.resolveInFrames)(ctx, selectorExpr);
                if (!match)
                    throw new Error(`Element not found: ${action.selector}`);
                const expr = `
          (() => {
            const el = ${selectorExpr};
            if (!el) return { scrolled: false };
            el.scrollTo(${action.x || 0}, ${action.y || 0});
            return { scrolled: true };
          })()
        `;
                const r = await (0, frames_1.evalInFrameOrTop)(ctx, expr, match.contextId);
                if (!r?.scrolled)
                    throw new Error(`Failed to scroll ${action.selector}`);
                return `Scrolled ${action.selector} to (${action.x || 0}, ${action.y || 0})`;
            }
            await ctx.eval(`window.scrollTo(${action.x || 0}, ${action.y || 0})`);
            return `Scrolled window to (${action.x || 0}, ${action.y || 0})`;
        }
        case 'scroll_by': {
            if (action.selector) {
                const selectorExpr = ctx.getSelectorExpression(action.selector);
                const match = await (0, frames_1.resolveInFrames)(ctx, selectorExpr);
                if (!match)
                    throw new Error(`Element not found: ${action.selector}`);
                const expr = `
          (() => {
            const el = ${selectorExpr};
            if (!el) return { scrolled: false };
            el.scrollBy(${action.x || 0}, ${action.y || 0});
            return { scrolled: true };
          })()
        `;
                const r = await (0, frames_1.evalInFrameOrTop)(ctx, expr, match.contextId);
                if (!r?.scrolled)
                    throw new Error(`Failed to scroll ${action.selector}`);
                return `Scrolled ${action.selector} by (${action.x || 0}, ${action.y || 0})`;
            }
            await ctx.eval(`window.scrollBy(${action.x || 0}, ${action.y || 0})`);
            return `Scrolled window by (${action.x || 0}, ${action.y || 0})`;
        }
        case 'scroll_into_view': {
            const selectorExpr = ctx.getSelectorExpression(action.selector);
            const match = await (0, frames_1.resolveInFrames)(ctx, selectorExpr);
            if (!match)
                throw new Error(`Element not found: ${action.selector}`);
            const expr = `
        (() => {
          const el = ${selectorExpr};
          if (!el) return { scrolled: false };
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return { scrolled: true };
        })()
      `;
            const r = await (0, frames_1.evalInFrameOrTop)(ctx, expr, match.contextId);
            if (!r?.scrolled)
                throw new Error(`Failed to scroll ${action.selector} into view`);
            return `Scrolled ${action.selector} into view`;
        }
        case 'select_option': {
            const selectorExpr = ctx.getSelectorExpression(action.selector);
            const match = await (0, frames_1.resolveInFrames)(ctx, selectorExpr);
            if (!match)
                throw new Error(`Element not found: ${action.selector}`);
            const target = JSON.stringify(action.value);
            const expr = `
        (() => {
          const el = ${selectorExpr};
          if (!el || el.tagName !== 'SELECT') return { selected: false, reason: 'not-a-select' };
          const options = Array.from(el.options);
          const target = ${target};

          // Match by value first, then by text
          let opt = options.find(o => o.value === target);
          if (!opt) opt = options.find(o => o.textContent?.trim().toLowerCase() === target.toLowerCase());
          if (!opt) return { selected: false, reason: 'no-option', available: options.map(o => o.textContent?.trim() || '') };

          // Use native setter to bypass frameworks
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
          if (nativeSetter) nativeSetter.call(el, opt.value);
          else el.value = opt.value;

          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { selected: true, optionText: opt.textContent?.trim() || opt.value };
        })()
      `;
            const r = await (0, frames_1.evalInFrameOrTop)(ctx, expr, match.contextId);
            if (!r?.selected)
                throw new Error(`Failed to select in ${action.selector}: ${r?.reason ?? 'unknown'}`);
            return `Selected "${r.optionText}" in ${action.selector}`;
        }
        case 'select_custom': {
            const triggerSelector = action.selector;
            const targetValue = action.value;
            if (!triggerSelector)
                throw new Error('select_custom requires a selector');
            if (!targetValue)
                throw new Error('select_custom requires a value');
            const expr = ctx.getSelectorExpression(triggerSelector);
            const triggerMatch = await (0, frames_1.resolveInFrames)(ctx, expr);
            if (!triggerMatch)
                throw new Error(`No custom dropdown trigger found at ${triggerSelector}.`);
            const frameContextId = triggerMatch.contextId;
            // Step 1: Detect the dropdown trigger element
            const detection = await (0, frames_1.evalInFrameOrTop)(ctx, `
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
      `, frameContextId);
            if (!detection?.found) {
                throw new Error(`No custom dropdown trigger found at ${triggerSelector}. Use select_option for native <select> elements.`);
            }
            // Step 2: Snapshot existing options before opening, then click the trigger
            const beforeSnapshot = await (0, frames_1.evalInFrameOrTop)(ctx, `
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
      `, frameContextId) || [];
            const { x, y } = await (0, frames_1.getCenterInFrame)(ctx, triggerSelector);
            await moveCursorTo(ctx, x, y, '_default');
            await ctx.cdp('Input.dispatchMouseEvent', {
                type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1,
            });
            await ctx.sleep(78 + Math.floor(Math.random() * 64));
            await ctx.cdp('Input.dispatchMouseEvent', {
                type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
            });
            await (0, frames_1.evalInFrameOrTop)(ctx, `(() => {
        const el = document.elementFromPoint(${x}, ${y});
        if (el) el.click();
      })()`, frameContextId).catch(() => { });
            // Wait for dropdown to render
            await ctx.sleep(300);
            // Step 3: Find and click the target option — only consider options
            // that appeared AFTER the click (scopes to this dropdown, not others)
            const optionResult = await (0, frames_1.evalInFrameOrTop)(ctx, `
        (() => {
          ${option_matcher_1.OPTION_MATCHER_JS}
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
      `, frameContextId);
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
            const verification = await (0, frames_1.evalInFrameOrTop)(ctx, `
        (() => {
          const el = ${expr};
          if (!el) return { verified: false, currentText: '' };
          const currentText = el.textContent?.trim().substring(0, 100) || '';
          const before = ${JSON.stringify(detection.triggerText)};
          return { verified: currentText !== before, currentText };
        })()
      `, frameContextId);
            if (verification?.verified) {
                return `Selected "${optionResult.optionText}" in custom dropdown ${triggerSelector}`;
            }
            return `⚠ Selected "${optionResult.optionText}" in custom dropdown ${triggerSelector} (unverified — trigger text unchanged after option click; the dropdown may not have committed selection state)`;
        }
        case 'file_upload': {
            const selectorExpr = `document.querySelector(${JSON.stringify(action.selector)})`;
            const verificationExpr = `
        (() => {
          const el = document.querySelector(${JSON.stringify(action.selector)});
          if (!el) return { verified: false, count: 0 };
          const count = el.files ? el.files.length : 0;
          return { verified: count === ${action.files.length}, count };
        })()
      `;
            // Step 1: Try top frame first (unchanged happy path).
            const evalResult = await ctx.cdp('Runtime.evaluate', {
                expression: selectorExpr,
                returnByValue: false,
            });
            let objectId = evalResult.result?.objectId;
            let frameContextId = null;
            // Step 2: If top frame has no match, walk child frames in DFS order.
            if (!objectId) {
                const match = await (0, frames_1.findElementInFrames)(ctx, selectorExpr);
                if (!match) {
                    throw new Error(`Element not found in any frame: ${action.selector}`);
                }
                objectId = match.objectId;
                frameContextId = match.contextId;
            }
            const nodeResult = await ctx.cdp('DOM.describeNode', { objectId });
            await ctx.cdp('DOM.setFileInputFiles', {
                files: action.files,
                backendNodeId: nodeResult.node.backendNodeId,
            });
            // Post-action read-back: confirm the input now reports the expected file count.
            // setFileInputFiles is a CDP-only operation that doesn't always fire 'change',
            // so the page-level state (and any React listeners) may not see the upload.
            // CRITICAL: the read-back must run in the SAME frame context as the input —
            // querying the top frame after uploading to a child frame always reports 0.
            let verification;
            if (frameContextId !== null) {
                const r = await ctx.cdp('Runtime.evaluate', {
                    expression: verificationExpr,
                    contextId: frameContextId,
                    returnByValue: true,
                });
                verification = r.result?.value;
            }
            else {
                verification = await ctx.eval(verificationExpr);
            }
            const expectedCount = action.files.length;
            if (verification?.verified) {
                return `Uploaded ${expectedCount} file(s) to ${action.selector}`;
            }
            return `⚠ Uploaded ${expectedCount} file(s) to ${action.selector} (unverified — input reports ${verification?.count ?? 0} file(s) after upload; the page may not have observed the change)`;
        }
        case 'force_pseudo_state': {
            const pseudoStates = action.pseudoStates || [];
            const doc = await ctx.cdp('DOM.getDocument', {});
            const topResult = await ctx.cdp('DOM.querySelector', {
                nodeId: doc.root.nodeId,
                selector: action.selector,
            });
            let nodeId = topResult.nodeId;
            if (!nodeId) {
                const selectorExpr = ctx.getSelectorExpression(action.selector);
                const match = await (0, frames_1.findElementInFrames)(ctx, selectorExpr);
                if (!match)
                    throw new Error(`Element not found: ${action.selector}`);
                const req = await ctx.cdp('DOM.requestNode', { objectId: match.objectId });
                nodeId = req.nodeId;
            }
            if (!nodeId)
                throw new Error(`Element not found: ${action.selector}`);
            await ctx.cdp('CSS.forcePseudoState', {
                nodeId,
                forcedPseudoClasses: pseudoStates,
            });
            return `Forced pseudo-states [${pseudoStates.join(', ')}] on ${action.selector}`;
        }
        default:
            throw new Error(`Unknown action type: ${action.type}`);
    }
}
//# sourceMappingURL=interaction.js.map