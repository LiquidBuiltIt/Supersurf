import { registerAction } from './registry';
import { resolveInFrames, evalInFrameOrTop } from '../lib/frames';
import { KEY_MAP } from './helpers';

registerAction({
  name: 'type',
  async run(ctx, action) {
    let typeContextId: number | null = null;
    if (action.selector) {
      const selectorExpr = ctx.getSelectorExpression(action.selector);
      const meta = { name: action.name, purpose: action.purpose };
      const match = await resolveInFrames(ctx, selectorExpr, action.selector, meta);
      if (!match) throw new Error(`Element not found: ${action.selector}`);
      typeContextId = match.contextId;
      const focusExpr = `
        (() => {
          const el = ${selectorExpr};
          if (!el) return { focused: false };
          el.focus();
          return { focused: document.activeElement === el };
        })()
      `;
      const focusResult = await evalInFrameOrTop(ctx, focusExpr, typeContextId);
      if (!focusResult?.focused) throw new Error(`Failed to focus ${action.selector}`);
    }

    for (const char of action.text) {
      if (char === '\r') continue; // CRLF normalization — the \n dispatches Enter
      if (char === '\n') {
        const enter = KEY_MAP.Enter;
        await ctx.cdp('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: enter.key, code: enter.code, keyCode: enter.keyCode, text: enter.text,
        });
        await ctx.cdp('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: enter.key, code: enter.code, keyCode: enter.keyCode,
        });
        continue;
      }
      await ctx.cdp('Input.dispatchKeyEvent', { type: 'char', text: char });
    }

    if (action.selector) {
      const selectorExpr = ctx.getSelectorExpression(action.selector);
      const readExpr = `(() => { const el = ${selectorExpr}; return el?.value; })()`;
      const finalValue = await evalInFrameOrTop(ctx, readExpr, typeContextId);
      return `Typed "${action.text}" into ${action.selector} (value: "${finalValue ?? 'N/A'}")`;
    }
    return `Typed "${action.text}" into focused element`;
  },
});
