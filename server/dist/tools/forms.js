"use strict";
/**
 * Form filling, drag, and secure fill tool handlers.
 *
 * Implements three tools:
 * - `browser_fill_form`: Batch-set values on multiple form fields
 * - `browser_drag`: Simulate drag-and-drop between two elements via CDP mouse events
 * - `secure_fill`: Fill a field from a server-side env var without exposing the value to the agent
 *
 * Form filling uses native property setters (bypassing framework getters)
 * and dispatches input/change events for React/Vue/Angular compatibility.
 *
 * @module tools/forms
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.onFillForm = onFillForm;
exports.onDrag = onDrag;
exports.onSecureFill = onSecureFill;
const frames_1 = require("./lib/frames");
const dotenv_1 = require("../dotenv");
/**
 * Set values on multiple form fields at once.
 *
 * Handles input, textarea, select (single and multi), checkbox, and radio
 * elements. Uses native prototype setters to bypass framework-managed
 * value properties, then fires input + change events.
 *
 * Auto-falls-back to child frames when a selector doesn't resolve in the
 * top frame — mirrors the v1.10.0 `browser_interact` iframe-walk pattern
 * (see `tools/lib/frames.ts`).
 *
 * @param args - `{ fields: Array<{ selector: string, value: string }> }`
 */
async function onFillForm(ctx, args, options) {
    const fields = args.fields;
    const results = [];
    for (const field of fields) {
        const expr = ctx.getSelectorExpression(field.selector);
        // Resolve top frame first, then DFS child frames on miss.
        const match = await (0, frames_1.resolveInFrames)(ctx, expr);
        if (!match)
            throw new Error('Element not found: ' + field.selector);
        const fillExpr = `
      (async () => {
        const el = ${expr};
        if (!el) throw new Error('Element not found: ' + ${JSON.stringify(field.selector)});
        const tag = el.tagName;
        const type = el.type;

        // Focus the element first (triggers onFocus handlers)
        el.dispatchEvent(new Event('focus', { bubbles: true }));
        el.focus();

        if (type === 'checkbox' || type === 'radio') {
          const checked = ${JSON.stringify(field.value)} === 'true' || ${JSON.stringify(field.value)} === true;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
          if (setter) setter.call(el, checked);
          else el.checked = checked;
        } else if (tag === 'SELECT') {
          const options = Array.from(el.options);
          const target = ${JSON.stringify(field.value)};
          if (el.multiple) {
            const targets = target.split(',').map(t => t.trim());
            for (const opt of options) {
              opt.selected = targets.includes(opt.value) || targets.includes(opt.textContent?.trim());
            }
          } else {
            let opt = options.find(o => o.value === target);
            if (!opt) opt = options.find(o => o.textContent?.trim().toLowerCase() === target.toLowerCase());
            if (!opt) throw new Error('Option not found: ' + target);
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
            if (setter) setter.call(el, opt.value);
            else el.value = opt.value;
          }
        } else if (tag === 'TEXTAREA') {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          if (setter) setter.call(el, ${JSON.stringify(field.value)});
          else el.value = ${JSON.stringify(field.value)};
        } else {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, ${JSON.stringify(field.value)});
          else el.value = ${JSON.stringify(field.value)};
        }

        // Plain Event triggers React's value-tracker diff (per facebook/react#10135)
        el.dispatchEvent(new Event('input', { bubbles: true }));
        // Microtask yield — let React reconcile before change fires
        await Promise.resolve();
        el.dispatchEvent(new Event('change', { bubbles: true }));
        // Microtask yield — let onChange handlers commit before blur fires
        await Promise.resolve();
        // Blur triggers onBlur validation handlers
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      })()
    `;
        await (0, frames_1.evalInFrameOrTop)(ctx, fillExpr, match.contextId);
        // Post-action read-back: confirm the DOM value reflects what we set.
        // Verification runs in the same frame context as the fill so iframe-nested
        // fields read back correctly. NOTE: This catches loud failures (wrong
        // selector, disabled input, rejected value) but does NOT catch React's
        // silent value-tracker drift. See docs/research/2026-04-08-fill-form-react-state-investigation.md
        // for the tracker failure mode and the deferred fiber-walk follow-up.
        const verifExpr = `
      (() => {
        const el = ${expr};
        if (!el) return { verified: false, actual: null };
        const actual = (el.type === 'checkbox' || el.type === 'radio')
          ? String(el.checked)
          : (el.value ?? '');
        const expected = ${JSON.stringify(String(field.value))};
        return { verified: actual === expected, actual };
      })()
    `;
        const verification = await (0, frames_1.evalInFrameOrTop)(ctx, verifExpr, match.contextId);
        if (verification?.verified) {
            results.push(`✓ ${field.selector} = "${field.value}"`);
        }
        else {
            const actualStr = verification?.actual === null
                ? 'element disappeared'
                : `actual: "${verification?.actual ?? ''}"`;
            results.push(`⚠ ${field.selector} = "${field.value}" (unverified — ${actualStr})`);
        }
    }
    if (options.rawResult)
        return { success: true, fields: results };
    return { content: [{ type: 'text', text: results.join('\n') }] };
}
/**
 * Drag one element to another using simulated CDP mouse events.
 * Moves in 10 interpolated steps for realistic drag behavior.
 *
 * @param args - `{ fromSelector: string, toSelector: string }`
 */
async function onDrag(ctx, args, options) {
    const from = await ctx.getElementCenter(args.fromSelector);
    const to = await ctx.getElementCenter(args.toSelector);
    // Press at source
    await ctx.cdp('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: from.x, y: from.y,
    });
    await ctx.cdp('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1,
    });
    // Move to target in steps
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
        const x = Math.round(from.x + (to.x - from.x) * (i / steps));
        const y = Math.round(from.y + (to.y - from.y) * (i / steps));
        await ctx.cdp('Input.dispatchMouseEvent', {
            type: 'mouseMoved', x, y, buttons: 1,
        });
    }
    // Release at target
    await ctx.cdp('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: to.x, y: to.y, button: 'left',
    });
    if (options.rawResult)
        return { success: true, from, to };
    return {
        content: [{
                type: 'text',
                text: `Dragged ${args.fromSelector} → ${args.toSelector}`,
            }],
    };
}
/**
 * Secure credential management — list available credentials or fill a form field.
 *
 * `list`: Returns env var names from .env (names only, never values).
 * `fill`: Resolves the env var server-side and sends the value directly to the
 *         extension, which types it char-by-char with randomized delays.
 *         The credential value never appears in MCP responses.
 */
async function onSecureFill(ctx, args, options) {
    const action = args.action;
    if (action === 'list') {
        const keys = (0, dotenv_1.getDotenvKeys)();
        if (options.rawResult) {
            return { success: true, credentials: keys };
        }
        if (keys.length === 0) {
            return {
                content: [{ type: 'text', text: 'No credentials found. Add variables to a `.env` file in your working directory.' }],
            };
        }
        return {
            content: [{ type: 'text', text: `### Available Credentials\n\n${keys.map(k => `- \`${k}\``).join('\n')}` }],
        };
    }
    // action === 'fill'
    const selector = args.selector;
    const envName = args.credential_env;
    if (!selector || !envName) {
        return ctx.error('Both `selector` and `credential_env` are required for the `fill` action.', options);
    }
    const value = process.env[envName];
    if (value === undefined) {
        const keys = (0, dotenv_1.getDotenvKeys)();
        const available = keys.length > 0 ? ` Available credentials: ${keys.join(', ')}` : ' No credentials found in .env file.';
        return ctx.error(`Environment variable "${envName}" is not set.${available}`, options);
    }
    await ctx.ext.sendCmd('secure_fill', { selector, value, tabId: ctx.tabId });
    if (options.rawResult) {
        return { success: true, selector, credential_env: envName };
    }
    return {
        content: [{
                type: 'text',
                text: `Securely filled \`${selector}\` with credential from \`${envName}\``,
            }],
    };
}
//# sourceMappingURL=forms.js.map