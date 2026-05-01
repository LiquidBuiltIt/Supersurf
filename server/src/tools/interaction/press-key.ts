import { registerAction } from './registry';
import { KEY_MAP } from './helpers';

registerAction({
  name: 'press_key',
  async run(ctx, action) {
    const key = action.key;
    const mapped = KEY_MAP[key];
    if (!mapped) throw new Error(`Unknown key: ${key}. Supported: ${Object.keys(KEY_MAP).join(', ')}`);
    await ctx.cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: mapped.key, code: mapped.code, keyCode: mapped.keyCode, text: mapped.text,
    });
    await ctx.cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: mapped.key, code: mapped.code, keyCode: mapped.keyCode,
    });
    return `Pressed ${key}`;
  },
});
