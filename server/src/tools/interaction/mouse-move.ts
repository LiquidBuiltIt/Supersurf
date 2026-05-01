import { registerAction } from './registry';
import { moveCursorTo } from './helpers';

registerAction({
  name: 'mouse_move',
  async run(ctx, action) {
    await moveCursorTo(ctx, action.x, action.y, '_default');
    return `Moved to (${action.x}, ${action.y})`;
  },
});
