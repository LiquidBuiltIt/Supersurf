import { registerAction } from './registry';
import { resolveInFrames } from '../lib/frames';
import { handleMissHint } from '../../experimental/fingerprinting/handle-resolve';
import { renderAlternatives } from '../lib/element-resolver';

registerAction({
  name: 'wait',
  async run(ctx, action) {
    const timeout = action.timeout || 30000;
    if (action.selector) {
      const selectorExpr = ctx.getSelectorExpression(action.selector);
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const match = await resolveInFrames(ctx, selectorExpr);
        if (match) return `Element appeared: ${action.selector}`;
        await ctx.sleep(100);
      }
      const alts = await ctx.findAlternativeSelectors(action.selector).catch(() => []);
      const block = renderAlternatives(alts as any);
      throw new Error(
        `Timeout waiting for element: ${action.selector}${handleMissHint(action.selector)}` +
        (block ? `\n\n${block}` : ''),
      );
    }
    await ctx.sleep(timeout);
    return `Waited ${timeout}ms`;
  },
});
