/**
 * Connection-level tool schema definitions.
 *
 * Defines MCP tool schemas for the four connection management tools (connect, disconnect,
 * status, experimental_features) and the debug-only reload tool. These are always
 * available regardless of connection state, unlike browser tools which require an
 * active extension connection.
 *
 * @module backend/schemas
 * @exports getConnectionToolSchemas - Returns schemas for connection lifecycle tools
 * @exports getDebugToolSchema - Returns the reload_mcp schema (debug mode only)
 */

import type { ToolSchema } from './types';

/** Return MCP tool schemas for connect, disconnect, status, and experimental_features. */
export function getConnectionToolSchemas(): ToolSchema[] {
  return [
    {
      name: 'connect',
      description:
        'Connect to the SuperSurf service and start browser automation. Pass a client_id to identify this session.',
      inputSchema: {
        type: 'object',
        properties: {
          client_id: {
            type: 'string',
            description:
              'Human-readable identifier for this MCP client (e.g., "my-project").',
          },
          profile: {
            type: 'string',
            description:
              'Profile name for isolated Chromium instance, or omit for unmanaged connection to user\'s own browser.',
          },
        },
        required: ['client_id'],
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
      description:
        'Disconnect this session from the SuperSurf service.',
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
      description:
        'Show current connection state: passive (idle), active (server up), or connected (extension linked).',
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
      description:
        'Toggle experimental features for this session. Available experiments:\n' +
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

/** Return MCP tool schemas for profile management (create, list, delete). */
export function getProfileToolSchemas(): ToolSchema[] {
  return [
    {
      name: 'profile_create',
      description:
        'Create a new isolated Chromium profile for browser automation. Each profile gets its own cookies, sessions, and state. Requires the `profiles` experiment enabled on the daemon (`SUPERSURF_EXPERIMENTS=profiles`).',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'Profile name. Lowercase alphanumeric + hyphens, max 32 chars (e.g., "scraper", "test-account").',
          },
          experiments: {
            type: 'object',
            description:
              'Optional experiment defaults to pre-enable when connecting to this profile (e.g., { "mouse_humanization": true }).',
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
      description: 'List all managed Chromium profiles with their running state. Requires the `profiles` experiment enabled on the daemon.',
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
      description:
        'Delete a managed Chromium profile and all its data. Cannot delete profiles with active sessions. Requires the `profiles` experiment enabled on the daemon.',
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
export function getDebugToolSchema(): ToolSchema {
  return {
    name: 'reload_mcp',
    description:
      'Hot-reload the MCP server. Debug mode only. Server exits with code 42 and the wrapper restarts it.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    annotations: {
      title: 'Reload MCP server',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
  };
}
