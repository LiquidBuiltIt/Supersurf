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

import type { ToolContext } from './types';

/**
 * Set values on multiple form fields at once.
 *
 * Handles input, textarea, select (single and multi), checkbox, and radio
 * elements. Uses native prototype setters to bypass framework-managed
 * value properties, then fires input + change events.
 *
 * @param args - `{ fields: Array<{ selector: string, value: string }> }`
 */
export async function onFillForm(ctx: ToolContext, args: any, options: any): Promise<any> {
  const fields = args.fields as any[];
  const results: string[] = [];

  for (const field of fields) {
    const expr = ctx.getSelectorExpression(field.selector);
    await ctx.eval(`
      (() => {
        const el = ${expr};
        if (!el) throw new Error('Element not found: ${field.selector}');
        const tag = el.tagName;
        const type = el.type;

        if (type === 'checkbox' || type === 'radio') {
          el.checked = ${JSON.stringify(field.value)} === 'true' || ${JSON.stringify(field.value)} === true;
        } else if (tag === 'SELECT') {
          const options = Array.from(el.options);
          const target = ${JSON.stringify(field.value)};
          if (el.multiple) {
            // Multi-select: value can be comma-separated
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

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
    results.push(`✓ ${field.selector} = "${field.value}"`);
  }

  if (options.rawResult) return { success: true, fields: results };
  return { content: [{ type: 'text', text: results.join('\n') }] };
}

/**
 * Drag one element to another using simulated CDP mouse events.
 * Moves in 10 interpolated steps for realistic drag behavior.
 *
 * @param args - `{ fromSelector: string, toSelector: string }`
 */
export async function onDrag(ctx: ToolContext, args: any, options: any): Promise<any> {
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

  if (options.rawResult) return { success: true, from, to };
  return {
    content: [{
      type: 'text',
      text: `Dragged ${args.fromSelector} → ${args.toSelector}`,
    }],
  };
}

/**
 * Fill a form field with a credential from a server-side environment variable.
 *
 * The agent only provides the env var name — the actual value is resolved
 * server-side and sent directly to the extension, which types it char-by-char
 * with randomized delays. The credential value never appears in MCP responses.
 *
 * @param args - `{ selector: string, credential_env: string }`
 */
export async function onSecureFill(ctx: ToolContext, args: any, options: any): Promise<any> {
  const selector = args.selector as string;
  const envName = args.credential_env as string;

  if (!selector || !envName) {
    return ctx.error('Both selector and credential_env are required.', options);
  }

  const value = process.env[envName];
  if (value === undefined) {
    return ctx.error(
      `Environment variable "${envName}" is not set. Set it before starting the server.`,
      options
    );
  }

  await ctx.ext.sendCmd('secure_fill', { selector, value });

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
