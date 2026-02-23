"use strict";
/**
 * Storage Inspection — experimental MCP tool for reading/writing browser storage.
 *
 * Self-contained module: defines the `browser_storage` tool schema, validates
 * input, gates on the `storage_inspection` experiment flag, and delegates
 * actual storage operations to content-script eval via ctx.eval().
 *
 * Supports localStorage and sessionStorage with get/set/delete/clear/list actions.
 *
 * @module experimental/storage-inspection
 *
 * Key exports:
 * - {@link storageInspectionSchema} — MCP tool schema for browser_storage
 * - {@link onBrowserStorage} — handler that validates, gates, and executes storage ops
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.storageInspectionSchema = void 0;
exports.onBrowserStorage = onBrowserStorage;
const index_1 = require("./index");
exports.storageInspectionSchema = {
    name: 'browser_storage',
    description: 'Inspect and modify browser storage (localStorage/sessionStorage). Requires the `storage_inspection` experiment to be enabled.',
    inputSchema: {
        type: 'object',
        properties: {
            type: {
                type: 'string',
                enum: ['localStorage', 'sessionStorage'],
                description: 'Which storage to target',
            },
            action: {
                type: 'string',
                enum: ['get', 'set', 'delete', 'clear', 'list'],
                description: 'Storage operation',
            },
            key: {
                type: 'string',
                description: 'Storage key (required for get/set/delete)',
            },
            value: {
                type: 'string',
                description: 'Value to store (required for set)',
            },
        },
        required: ['type', 'action'],
    },
    annotations: {
        title: 'Browser storage',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
    },
};
/**
 * Handle a `browser_storage` tool call.
 * Validates the experiment gate, input params, then executes the storage
 * operation in the page context via ctx.eval().
 *
 * @param ctx - Tool context providing eval() and formatting helpers
 * @param args - Tool arguments (type, action, key?, value?)
 * @param options - Pass-through options (rawResult mode)
 * @returns Formatted tool response or error
 */
async function onBrowserStorage(ctx, args, options = {}) {
    if (!index_1.experimentRegistry.isEnabled('storage_inspection')) {
        return ctx.error('The `storage_inspection` experiment is not enabled. ' +
            'Use the `experimental_features` tool to enable it first.', options);
    }
    const storageType = args.type;
    const action = args.action;
    const key = args.key;
    const value = args.value;
    if (!['localStorage', 'sessionStorage'].includes(storageType)) {
        return ctx.error(`Invalid storage type: "${storageType}". Must be "localStorage" or "sessionStorage".`, options);
    }
    if (!['get', 'set', 'delete', 'clear', 'list'].includes(action)) {
        return ctx.error(`Invalid action: "${action}". Must be one of: get, set, delete, clear, list.`, options);
    }
    // Validate required params per action
    if (['get', 'set', 'delete'].includes(action) && !key) {
        return ctx.error(`Action "${action}" requires a "key" parameter.`, options);
    }
    if (action === 'set' && (value === undefined || value === null)) {
        return ctx.error('Action "set" requires a "value" parameter.', options);
    }
    switch (action) {
        case 'list': {
            const result = await ctx.eval(`
        (() => {
          const s = ${storageType};
          const entries = {};
          for (let i = 0; i < s.length; i++) {
            const k = s.key(i);
            entries[k] = s.getItem(k);
          }
          return { length: s.length, entries };
        })()
      `);
            return ctx.formatResult('browser_storage', result, options);
        }
        case 'get': {
            const result = await ctx.eval(`${storageType}.getItem(${JSON.stringify(key)})`);
            return ctx.formatResult('browser_storage', {
                key,
                value: result,
                exists: result !== null,
            }, options);
        }
        case 'set': {
            await ctx.eval(`${storageType}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
            return ctx.formatResult('browser_storage', {
                key,
                value,
                action: 'set',
                success: true,
            }, options);
        }
        case 'delete': {
            const existed = await ctx.eval(`${storageType}.getItem(${JSON.stringify(key)}) !== null`);
            await ctx.eval(`${storageType}.removeItem(${JSON.stringify(key)})`);
            return ctx.formatResult('browser_storage', {
                key,
                action: 'delete',
                existed,
                success: true,
            }, options);
        }
        case 'clear': {
            const countBefore = await ctx.eval(`${storageType}.length`);
            await ctx.eval(`${storageType}.clear()`);
            return ctx.formatResult('browser_storage', {
                action: 'clear',
                itemsCleared: countBefore,
                success: true,
            }, options);
        }
        default:
            return ctx.error(`Unknown action: "${action}"`, options);
    }
}
//# sourceMappingURL=storage-inspection.js.map