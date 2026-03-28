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
const index_1 = require("../experimental/index");
const index_2 = require("../experimental/mouse-humanization/index");
const logger_1 = require("../logger");
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
            results.push(`✓ ${action.type}: ${msg}`);
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
            if (action.selector) {
                ({ x, y } = await ctx.getElementCenter(action.selector));
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
            // Dispatch DOM-level click for navigation (CDP mouse events don't synthesize click)
            await ctx.eval(`(() => {
        const el = document.elementFromPoint(${x}, ${y});
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
            const targetValue = action.value;
            if (!triggerSelector)
                throw new Error('select_custom requires a selector');
            if (!targetValue)
                throw new Error('select_custom requires a value');
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
      })()`).catch(() => { });
            // Wait for dropdown to render
            await ctx.sleep(300);
            // Step 3: Find and click the target option — only consider options
            // that appeared AFTER the click (scopes to this dropdown, not others)
            const optionResult = await ctx.eval(`
        (() => {
          const target = ${JSON.stringify(targetValue)};
          const targetLower = target.toLowerCase();
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

          // Search candidates for matching option
          for (const opt of candidates) {
            const text = opt.textContent?.trim() || '';
            const value = opt.getAttribute('data-value') || opt.getAttribute('value') || '';
            if (text.toLowerCase() === targetLower || value.toLowerCase() === targetLower) {
              opt.scrollIntoView({ block: 'nearest' });
              opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              opt.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              opt.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              return { found: true, optionText: text || value };
            }
          }

          // Collect available options for error message
          const available = [];
          for (const opt of candidates) {
            const t = opt.textContent?.trim();
            if (t && !available.includes(t)) available.push(t);
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
            return `Selected "${optionResult.optionText}" in custom dropdown ${triggerSelector}`;
        }
        case 'file_upload': {
            const evalResult = await ctx.cdp('Runtime.evaluate', {
                expression: `document.querySelector(${JSON.stringify(action.selector)})`,
                returnByValue: false,
            });
            if (!evalResult.result?.objectId)
                throw new Error(`Element not found: ${action.selector}`);
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
            if (!nodeResult.nodeId)
                throw new Error(`Element not found: ${action.selector}`);
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
//# sourceMappingURL=interaction.js.map