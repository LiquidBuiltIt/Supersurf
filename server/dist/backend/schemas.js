"use strict";
/**
 * Connection-level tool schema definitions.
 *
 * Defines MCP tool schemas for the three connection management tools (connect, disconnect,
 * status) and the debug-only reload tool. These are always available regardless of
 * connection state, unlike browser tools which require an active extension connection.
 *
 * Experiments are configured via `~/.supersurf/config.json` (auto-scaffolded on first
 * daemon start) and require a daemon restart to take effect.
 *
 * @module backend/schemas
 * @exports getConnectionToolSchemas - Returns schemas for connection lifecycle tools
 * @exports getDebugToolSchema - Returns the reload_mcp schema (debug mode only)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConnectionToolSchemas = getConnectionToolSchemas;
exports.getProfileToolSchemas = getProfileToolSchemas;
exports.getDebugToolSchema = getDebugToolSchema;
/** Return MCP tool schemas for connect, disconnect, and status. */
function getConnectionToolSchemas() {
    return [
        {
            name: 'connect',
            description: 'Register this agent under `username` and connect. Pass the same `username` to every later call. Read the skill guide for best practices: https://liquidbuiltit.github.io/Supersurf/skill.md',
            inputSchema: {
                type: 'object',
                properties: {
                    username: {
                        type: 'string',
                        description: 'Your agent name, 1-64 chars `[A-Za-z0-9._-]`. Every later SuperSurf call must pass the same `username`. Child agents pick their own.',
                    },
                    profile: {
                        type: 'string',
                        description: 'Profile name for isolated Chromium instance, or omit for unmanaged connection to user\'s own browser.',
                    },
                },
                required: ['username'],
            },
            annotations: {
                title: 'Connect to service',
                readOnlyHint: false,
                destructiveHint: false,
                openWorldHint: false,
            },
        },
        {
            name: 'disconnect',
            description: 'End your session: closes the tabs you created, releases tabs you attached to.',
            inputSchema: { type: 'object', properties: {}, required: [] },
            annotations: {
                title: 'Disconnect from service',
                readOnlyHint: false,
                destructiveHint: false,
                openWorldHint: false,
            },
        },
        {
            name: 'status',
            description: 'Without `username`: server and daemon health. With your `username`: the status of your own session.',
            inputSchema: {
                type: 'object',
                properties: { username: { type: 'string', description: 'Your agent name. Omit for a health check that names no one.' } },
                required: [],
            },
            annotations: {
                title: 'Connection status',
                readOnlyHint: true,
                destructiveHint: false,
                openWorldHint: false,
            },
        },
    ];
}
/** Return MCP tool schemas for profile management (create, list, delete). */
function getProfileToolSchemas() {
    return [
        {
            name: 'profile_create',
            description: 'Create a new isolated Chromium profile for browser automation. Each profile gets its own cookies, sessions, and state.',
            inputSchema: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'Profile name. Lowercase alphanumeric + hyphens, max 32 chars (e.g., "scraper", "test-account").',
                    },
                    experiments: {
                        type: 'object',
                        description: 'Optional experiment defaults to pre-enable when connecting to this profile (e.g., { "mouse_humanization": true }).',
                    },
                },
                required: ['name'],
            },
            annotations: {
                title: 'Create profile',
                readOnlyHint: false,
                destructiveHint: false,
                openWorldHint: false,
            },
        },
        {
            name: 'profile_list',
            description: 'List all managed Chromium profiles with their running state.',
            inputSchema: { type: 'object', properties: {}, required: [] },
            annotations: {
                title: 'List profiles',
                readOnlyHint: true,
                destructiveHint: false,
                openWorldHint: false,
            },
        },
        {
            name: 'profile_delete',
            description: 'Delete a managed Chromium profile and all its data. Cannot delete profiles with active sessions.',
            inputSchema: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'Name of the profile to delete.',
                    },
                },
                required: ['name'],
            },
            annotations: {
                title: 'Delete profile',
                readOnlyHint: false,
                destructiveHint: true,
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