/**
 * CSS styles inspection tool handler.
 *
 * Implements `browser_get_element_styles` — a DevTools Styles panel equivalent
 * for AI agents. Uses CDP's CSS domain to retrieve matched CSS rules,
 * inline styles, and computed values for a given selector.
 *
 * Features:
 * - Property filtering (inspect a single CSS property)
 * - Pseudo-state forcing (hover, focus, active, etc.)
 * - Source tracking with file:line references
 * - Applied/overridden/computed markers for cascade visibility
 *
 * @module tools/styles
 */
import type { ToolContext } from './types';
/**
 * Inspect computed and matched CSS rules for an element.
 *
 * Resolves the element via CDP DOM.querySelector, optionally forces pseudo-states,
 * then collects all matched rules and inline styles into a property map with
 * source/selector/importance tracking. Cleans up forced pseudo-states on exit.
 *
 * @param args - `{ selector: string, property?: string, pseudoState?: string[] }`
 */
export declare function onGetElementStyles(ctx: ToolContext, args: any, options: any): Promise<any>;
//# sourceMappingURL=styles.d.ts.map