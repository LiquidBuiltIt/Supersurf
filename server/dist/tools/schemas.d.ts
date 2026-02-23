/**
 * Tool schema definitions for all browser tools.
 *
 * Each schema describes a single MCP tool: its name, description,
 * JSON Schema input, and MCP annotations. These are registered with
 * the MCP server and exposed to AI agents as callable tools.
 *
 * Tools are grouped by category: tab management, navigation, interaction,
 * content extraction, styles, screenshots, evaluation, console, forms,
 * drag, window, verification, network, PDF, dialogs, extensions,
 * performance, downloads, and secure credential fill.
 *
 * @module tools/schemas
 */
import type { ToolSchema } from './types';
/** Returns all core (non-experimental) tool schemas. */
export declare function getToolSchemas(): ToolSchema[];
//# sourceMappingURL=schemas.d.ts.map