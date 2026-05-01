"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const registry_1 = require("./registry");
const helpers_1 = require("./helpers");
(0, registry_1.registerAction)({
    name: 'press_key',
    async run(ctx, action) {
        const key = action.key;
        const mapped = helpers_1.KEY_MAP[key];
        if (!mapped)
            throw new Error(`Unknown key: ${key}. Supported: ${Object.keys(helpers_1.KEY_MAP).join(', ')}`);
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
//# sourceMappingURL=press-key.js.map