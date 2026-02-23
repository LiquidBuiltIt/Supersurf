/**
 * Page diffing — compares DOM snapshots before/after interactions to produce
 * a lightweight summary of what changed on the page.
 *
 * When the `page_diffing` experiment is enabled, the server captures a PageState
 * snapshot before each browser_interact call and diffs it against the post-action
 * snapshot. The diff (added/removed text, element count delta) is appended to
 * the tool response along with a confidence score.
 *
 * Confidence scoring applies flat penalties for shadow DOM, iframes, and very large
 * pages — conditions that reduce snapshot completeness but don't invalidate the diff.
 *
 * @module experimental/page-diffing
 *
 * Key exports:
 * - {@link diffSnapshots} — compute added/removed text and element count delta
 * - {@link calculateConfidence} — score how complete the snapshot is (0.0 to 1.0)
 * - {@link formatDiffSection} — render diff + confidence as a markdown section
 */
/** Snapshot of observable page state at a point in time. */
export interface PageState {
    elementCount: number;
    textContent: string[];
    shadowRootCount: number;
    iframeCount: number;
    hiddenElementCount: number;
    pageElementCount: number;
}
/** Result of comparing two PageState snapshots. */
export interface DiffResult {
    added: string[];
    removed: string[];
    countDelta: number;
}
/**
 * Compute the diff between two page snapshots.
 * Uses set-based comparison on textContent arrays to find added/removed strings.
 *
 * @param before - Snapshot taken before the interaction
 * @param after - Snapshot taken after the interaction
 * @returns Added text, removed text, and net element count change
 */
export declare function diffSnapshots(before: PageState, after: PageState): DiffResult;
/**
 * Score how reliable the diff is based on page complexity.
 * Starts at 1.0 and applies flat penalties:
 * - Shadow DOM present: -0.05 (content may be hidden from snapshot)
 * - Iframes present: -0.05 (cross-origin content invisible)
 * - Large page (>5000 elements): -0.05 (snapshot may be incomplete)
 *
 * @param state - The post-interaction page snapshot
 * @returns Confidence between 0.0 and 1.0
 */
export declare function calculateConfidence(state: PageState): number;
/**
 * Render the diff and confidence as a markdown section appended to tool responses.
 * Truncates text entries to 60 chars and caps display at 5 items per category.
 *
 * @param diff - The computed diff result
 * @param confidence - Confidence score from calculateConfidence
 * @param state - Optional post-state for shadow DOM/iframe annotations
 * @returns Markdown-formatted diff section string
 */
export declare function formatDiffSection(diff: DiffResult, confidence: number, state?: PageState): string;
//# sourceMappingURL=page-diffing.d.ts.map