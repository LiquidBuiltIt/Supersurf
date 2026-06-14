"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAction = registerAction;
exports.executeAction = executeAction;
exports.getRegisteredActions = getRegisteredActions;
exports._clearRegistryForTest = _clearRegistryForTest;
const action_recorder_1 = require("../../recorder/action-recorder");
const registry = new Map();
function registerAction(handler) {
    if (registry.has(handler.name)) {
        throw new Error(`Action already registered: ${handler.name}`);
    }
    registry.set(handler.name, handler);
}
async function executeAction(ctx, action) {
    const handler = registry.get(action.type);
    if (!handler)
        throw new Error(`Unknown action type: ${action.type}`);
    const startedAt = Date.now();
    try {
        const result = await handler.run(ctx, action);
        (0, action_recorder_1.recordAction)(ctx, action, startedAt, result, null);
        return result;
    }
    catch (err) {
        (0, action_recorder_1.recordAction)(ctx, action, startedAt, null, err);
        throw err;
    }
}
function getRegisteredActions() {
    return [...registry.keys()];
}
/** Test-only: clear the registry. Do not call from production code. */
function _clearRegistryForTest() {
    registry.clear();
}
//# sourceMappingURL=registry.js.map