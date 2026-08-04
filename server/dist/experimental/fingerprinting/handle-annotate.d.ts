/** Selector shape -> canonical handle name. */
export type HandleIndex = Map<string, string>;
/**
 * Build the handle index for the page at `url`.
 *
 * Returns an empty index when the `fingerprinting` experiment is off, the URL has
 * no usable domain, or nothing was ever recorded on this exact route — callers then
 * render exactly as they did before. Never throws.
 */
export declare function buildHandleIndex(url: string | undefined): HandleIndex;
/**
 * Render a selector for agent-facing output, substituting the recorded handle when
 * there is one. An unrecorded selector comes back byte-identical.
 *
 * FORMAT NOTE: `name [selector]` — handle first, the CSS kept alongside it so the
 * agent always retains a working fallback. This shape is a deliberately cheap swap:
 * if it ever costs us accuracy, change the template on the line below (and its test).
 * Nothing downstream parses this string.
 */
export declare function annotateSelector(index: HandleIndex, selector: string): string;
//# sourceMappingURL=handle-annotate.d.ts.map