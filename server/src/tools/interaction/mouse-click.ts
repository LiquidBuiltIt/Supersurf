import { registerAction } from './registry';
import { moveCursorTo, detectSpawnedTabs } from './helpers';
import { experimentRegistry } from '../../experimental/index';

registerAction({
  name: 'mouse_click',
  async run(ctx, action) {
    const clickTimestamp = Date.now();
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

    await ctx.eval(`(() => {
      const el = document.elementFromPoint(${action.x}, ${action.y});
      if (el && (el.closest('a[href]') || el.onclick)) el.click();
    })()`).catch(() => {});

    if (experimentRegistry.isEnabled('smart_waiting')) {
      try { await ctx.ext.sendCmd('waitForReady', { timeout: 3000, stabilityMs: 300 }); }
      catch { /* non-blocking */ }
    }

    const spawned = await detectSpawnedTabs(ctx, clickTimestamp);
    if (spawned) return `Clicked at (${action.x}, ${action.y})\n${spawned}`;
    return `Clicked at (${action.x}, ${action.y})`;
  },
});
