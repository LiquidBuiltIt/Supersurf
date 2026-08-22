import { registerAction } from './registry';
import { resolveInFrames } from '../lib/frames';

registerAction({
  name: 'wait',
  async run(ctx, action) {
    const timeout = action.timeout || 30000;
    if (action.selector) {
      const selectorExpr = ctx.getSelectorExpression(action.selector);
      const meta = { name: action.name, purpose: action.purpose };
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const match = await resolveInFrames(ctx, selectorExpr, action.selector, meta);
        if (match) return `Element appeared: ${action.selector}`;
        await ctx.sleep(100);
      }
      throw new Error(`Timeout waiting for element: ${action.selector}`);
    }
    await ctx.sleep(timeout);
    return `Waited ${timeout}ms`;
  },
});
