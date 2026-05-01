import { registerAction } from './registry';
import { resolveInFrames, evalInFrameOrTop } from '../frames';

registerAction({
  name: 'clear',
  async run(ctx, action) {
    const selectorExpr = ctx.getSelectorExpression(action.selector);
    const match = await resolveInFrames(ctx, selectorExpr);
    if (!match) throw new Error(`Element not found: ${action.selector}`);
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
    const result = await evalInFrameOrTop(ctx, clearExpr, match.contextId);
    if (!result?.cleared) throw new Error(`Failed to clear ${action.selector}`);
    return `Cleared ${action.selector}`;
  },
});
