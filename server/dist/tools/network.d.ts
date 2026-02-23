/**
 * Network and console tool handlers.
 *
 * Implements `browser_network_requests` (list/details/replay/clear captured
 * HTTP traffic) and `browser_console_messages` (read page console output).
 *
 * Network requests are captured by the extension's webRequest listener and
 * stored in-memory. Filtering is applied server-side after retrieval.
 *
 * @module tools/network
 */
import type { ToolContext } from './types';
/**
 * List, inspect, replay, or clear captured network requests.
 *
 * Actions:
 * - `list` (default): Paginated list with optional URL/method/status/type filters
 * - `details`: Full details for a specific requestId
 * - `replay`: Re-send a captured request via page-context fetch()
 * - `clear`: Clear the captured request log
 *
 * @param args - `{ action?, urlPattern?, method?, status?, resourceType?, limit?, offset?, requestId?, jsonPath? }`
 */
export declare function onNetworkRequests(ctx: ToolContext, args: any, options: any): Promise<any>;
/**
 * Read captured console messages from the page, with optional filtering.
 *
 * @param args - `{ level?, text?, url?, limit?, offset? }`
 */
export declare function onConsoleMessages(ctx: ToolContext, args: any, options: any): Promise<any>;
//# sourceMappingURL=network.d.ts.map