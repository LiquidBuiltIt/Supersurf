"use strict";
/**
 * Connection-level tool schema definitions.
 *
 * Defines MCP tool schemas for the four connection management tools (enable, disable,
 * status, experimental_features) and the debug-only reload tool. These are always
 * available regardless of connection state, unlike browser tools which require an
 * active extension connection.
 *
 * @module backend/schemas
 * @exports getConnectionToolSchemas - Returns schemas for connection lifecycle tools
 * @exports getDebugToolSchema - Returns the reload_mcp schema (debug mode only)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConnectionToolSchemas = getConnectionToolSchemas;
exports.getDebugToolSchema = getDebugToolSchema;
/** Return MCP tool schemas for enable, disable, status, and experimental_features. */
function getConnectionToolSchemas() {
    return [
        {
            name: 'enable',
            description: 'Start browser automation. Spins up the WebSocket server and waits for the extension to connect. Pass a client_id to identify this session.',
            inputSchema: {
                type: 'object',
                properties: {
                    client_id: {
                        type: 'string',
                        description: 'Human-readable identifier for this MCP client (e.g., "my-project").',
                    },
                },
                required: ['client_id'],
            },
            annotations: {
                title: 'Enable browser automation',
                readOnlyHint: false,
                destructiveHint: false,
                openWorldHint: false,
            },
        },
        {
            name: 'disable',
            description: 'Stop browser automation. Tears down the WebSocket connection and returns to passive mode.',
            inputSchema: { type: 'object', properties: {}, required: [] },
            annotations: {
                title: 'Disable browser automation',
                readOnlyHint: false,
                destructiveHint: false,
                openWorldHint: false,
            },
        },
        {
            name: 'status',
            description: 'Show current connection state: passive (idle), active (server up), or connected (extension linked).',
            inputSchema: { type: 'object', properties: {}, required: [] },
            annotations: {
                title: 'Connection status',
                readOnlyHint: true,
                destructiveHint: false,
                openWorldHint: false,
            },
        },
        {
            name: 'experimental_features',
            description: 'Toggle experimental features for this session. Available experiments:\n' +
                '- **page_diffing**: After browser_interact, returns only DOM changes instead of requiring a full re-read. Includes a confidence score.\n' +
                '- **smart_waiting**: Replaces fixed navigation delays with adaptive DOM stability + network idle detection.\n' +
                '- **storage_inspection**: Enables the `browser_storage` tool for inspecting/modifying localStorage and sessionStorage.\n' +
                '- **mouse_humanization**: Replaces instant cursor teleportation with human-like Bezier trajectories, overshoot correction, and idle micro-movements.\n' +
                '- **secure_eval**: Analyzes JavaScript in browser_evaluate for dangerous patterns (network calls, storage access, code injection, obfuscation) via AST parsing. Blocks unsafe code before execution.',
            inputSchema: {
                type: 'object',
                properties: {
                    page_diffing: { type: 'boolean', description: 'Enable/disable page diffing experiment' },
                    smart_waiting: { type: 'boolean', description: 'Enable/disable smart waiting experiment' },
                    storage_inspection: { type: 'boolean', description: 'Enable/disable storage inspection experiment' },
                    mouse_humanization: { type: 'boolean', description: 'Enable/disable mouse humanization experiment' },
                    secure_eval: { type: 'boolean', description: 'Enable/disable secure eval experiment' },
                },
            },
            annotations: {
                title: 'Experimental features',
                readOnlyHint: false,
                destructiveHint: false,
                openWorldHint: false,
            },
        },
    ];
}
/** Return the reload_mcp tool schema. Only exposed when `--debug` is active. */
function getDebugToolSchema() {
    return {
        name: 'reload_mcp',
        description: 'Hot-reload the MCP server. Debug mode only. Server exits with code 42 and the wrapper restarts it.',
        inputSchema: { type: 'object', properties: {}, required: [] },
        annotations: {
            title: 'Reload MCP server',
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: false,
        },
    };
}
//# sourceMappingURL=schemas.js.map