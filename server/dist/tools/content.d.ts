/**
 * Content extraction tool handlers — snapshot, lookup, extract.
 *
 * Provides three read-only tools for inspecting page content:
 * - `browser_snapshot`: Returns the accessibility tree as indented role/name pairs
 * - `browser_lookup`: Finds elements by visible text, returning selectors and positions
 * - `browser_extract_content`: Converts page content to clean markdown with pagination
 *
 * @module tools/content
 */
import type { ToolContext } from './types';
/**
 * Return the page's accessibility tree as indented text.
 * Filters out generic/none roles to keep output meaningful.
 */
export declare function onSnapshot(ctx: ToolContext, options: any): Promise<any>;
/**
 * Find elements by visible text and return their selectors, positions, and visibility.
 * Prioritizes visible matches over hidden ones.
 *
 * @param args - `{ text: string, limit?: number }`
 */
export declare function onLookup(ctx: ToolContext, args: any, options: any): Promise<any>;
/**
 * Extract page content as clean markdown with pagination support.
 *
 * Modes:
 * - `auto`: Tries common content selectors (article, main, .content), falls back to body
 * - `full`: Uses document.body directly
 * - `selector`: Targets a specific CSS selector
 *
 * @param args - `{ mode?: string, selector?: string, max_lines?: number, offset?: number }`
 */
export declare function onExtractContent(ctx: ToolContext, args: any, options: any): Promise<any>;
//# sourceMappingURL=content.d.ts.map