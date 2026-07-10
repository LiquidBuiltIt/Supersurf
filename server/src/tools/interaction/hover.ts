import { registerAction } from './registry';
import { getCenterInFrame } from '../lib/frames';
import { moveCursorTo } from './helpers';

registerAction({
  name: 'hover',
  async run(ctx, action) {
    const meta = { name: action.name, purpose: action.purpose };
    const { x, y } = await getCenterInFrame(ctx, action.selector, meta);
    await moveCursorTo(ctx, x, y, '_default');
    return `Hovered ${action.selector} at (${x}, ${y})`;
  },
});
