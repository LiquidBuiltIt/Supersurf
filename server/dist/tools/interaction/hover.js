"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const registry_1 = require("./registry");
const frames_1 = require("../lib/frames");
const helpers_1 = require("./helpers");
(0, registry_1.registerAction)({
    name: 'hover',
    async run(ctx, action) {
        const meta = { name: action.name, purpose: action.purpose };
        const { x, y } = await (0, frames_1.getCenterInFrame)(ctx, action.selector, meta);
        await (0, helpers_1.moveCursorTo)(ctx, x, y, '_default');
        return `Hovered ${action.selector} at (${x}, ${y})`;
    },
});
//# sourceMappingURL=hover.js.map