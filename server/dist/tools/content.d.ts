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
import type { ToolContext } from './lib/types';
/**
 * Coalesce adjacent `InlineTextBox` siblings under the same parent into a single
 * text node. Chrome's AX tree splits long text runs into one `InlineTextBox` per
 * visual line, which bloats snapshot output and makes it harder to read. This
 * merges consecutive InlineTextBox nodes that share the same `parentId` into one
 * node whose `name.value` is the joined text. Non-InlineTextBox siblings between
 * two InlineTextBox nodes break the run — nothing is merged across element types.
 *
 * Names are trimmed, collapsed on internal whitespace, and joined with a single
 * space. The first node of a run is kept (depth, parentId, etc.) and has its
 * `name.value` replaced with the coalesced text.
 *
 * Raw result mode (`rawResult: true`) bypasses this — callers opting into raw
 * data get the unmodified CDP output.
 */
export declare function coalesceInlineTextBoxes(nodes: any[]): any[];
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
 * Ceiling on how many matched roots selector mode RENDERS.
 *
 * The match count itself is unbounded by the page: `mode:'selector'` with a
 * selector like `div` matches thousands of NESTED roots, and every ancestor
 * re-renders its descendants' subtrees — quadratic output that crosses CDP in
 * full before `max_lines` ever slices it. `queryAllDeep` pierces shadow roots,
 * widening it further.
 *
 * The cap is on rendering only. `matches` keeps reporting the TRUE total and
 * the rendered header says plainly when the list was cut, because this is a
 * transparent harness: it tells the agent what is on the page and lets the
 * agent narrow the selector, rather than quietly pretending 50 was all of it.
 */
export declare const MAX_SELECTOR_MATCHES = 50;
/**
 * Extract page content as clean markdown with pagination support.
 *
 * Modes:
 * - `auto`: Tries common content selectors (article, main, .content), falls back to body
 * - `full`: Uses document.body directly
 * - `selector`: Targets a CSS selector and returns every element it matches, up
 *   to `MAX_SELECTOR_MATCHES`
 *
 * Selector mode used to read only the first match, which silently hid N-1
 * elements whenever the selector was a class shared by siblings (`.WorkflowJob`
 * on a GitHub Actions run page reported `total: 1` against 22 jobs). First-match
 * was never a documented guarantee, so this is a fix, not a flag: the caller now
 * gets every match, separated by a `---` rule, with the count in `matches`.
 * `auto` and `full` are unaffected — they have exactly one root by definition.
 *
 * @param args - `{ mode?: string, selector?: string, max_lines?: number, offset?: number }`
 */
export declare function onExtractContent(ctx: ToolContext, args: any, options: any): Promise<any>;
//# sourceMappingURL=content.d.ts.map