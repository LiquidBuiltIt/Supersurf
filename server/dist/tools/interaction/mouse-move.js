"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const registry_1 = require("./registry");
const helpers_1 = require("./helpers");
(0, registry_1.registerAction)({
    name: 'mouse_move',
    async run(ctx, action) {
        await (0, helpers_1.moveCursorTo)(ctx, action.x, action.y);
        return `Moved to (${action.x}, ${action.y})`;
    },
});
//# sourceMappingURL=mouse-move.js.map