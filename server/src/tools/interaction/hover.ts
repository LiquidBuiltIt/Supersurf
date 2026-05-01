import { registerAction } from './registry';
import { getCenterInFrame } from '../frames';
import { moveCursorTo } from './helpers';

registerAction({
  name: 'hover',
  async run(ctx, action) {
    const { x, y } = await getCenterInFrame(ctx, action.selector);
    await moveCursorTo(ctx, x, y, '_default');
    return `Hovered ${action.selector} at (${x}, ${y})`;
  },
});
