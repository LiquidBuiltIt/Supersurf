import { registerAction } from './registry';
import { resolveInFrames, evalInFrameOrTop } from '../lib/frames';

registerAction({
  name: 'select_option',
  async run(ctx, action) {
    const selectorExpr = ctx.getSelectorExpression(action.selector);
    const meta = { name: action.name, purpose: action.purpose };
    const match = await resolveInFrames(ctx, selectorExpr, action.selector, meta);
    if (!match) throw new Error(`Element not found: ${action.selector}`);
    const target = JSON.stringify(action.value);
    const expr = `
      (() => {
        const el = ${match.resolvedExpr};
        if (!el || el.tagName !== 'SELECT') return { selected: false, reason: 'not-a-select' };
        const options = Array.from(el.options);
        const target = ${target};

        let opt = options.find(o => o.value === target);
        if (!opt) opt = options.find(o => o.textContent?.trim().toLowerCase() === target.toLowerCase());
        if (!opt) return { selected: false, reason: 'no-option', available: options.map(o => o.textContent?.trim() || '') };

        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        if (nativeSetter) nativeSetter.call(el, opt.value);
        else el.value = opt.value;

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { selected: true, optionText: opt.textContent?.trim() || opt.value };
      })()
    `;
    const r = await evalInFrameOrTop(ctx, expr, match.contextId);
    if (!r?.selected) throw new Error(`Failed to select in ${action.selector}: ${r?.reason ?? 'unknown'}`);
    return `Selected "${r.optionText}" in ${action.selector}`;
  },
});
