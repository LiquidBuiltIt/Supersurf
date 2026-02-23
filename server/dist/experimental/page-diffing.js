"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.diffSnapshots = diffSnapshots;
exports.calculateConfidence = calculateConfidence;
exports.formatDiffSection = formatDiffSection;
/**
 * Compute the diff between two page snapshots.
 * Uses set-based comparison on textContent arrays to find added/removed strings.
 *
 * @param before - Snapshot taken before the interaction
 * @param after - Snapshot taken after the interaction
 * @returns Added text, removed text, and net element count change
 */
function diffSnapshots(before, after) {
    const beforeSet = new Set(before.textContent);
    const afterSet = new Set(after.textContent);
    const added = after.textContent.filter(t => !beforeSet.has(t));
    const removed = before.textContent.filter(t => !afterSet.has(t));
    const countDelta = after.elementCount - before.elementCount;
    return { added, removed, countDelta };
}
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
function calculateConfidence(state) {
    let confidence = 1.0;
    // Flat penalties — shadow DOM and iframes reduce visibility but don't invalidate the diff
    if (state.shadowRootCount > 0)
        confidence -= 0.05;
    if (state.iframeCount > 0)
        confidence -= 0.05;
    if (state.pageElementCount > 5000)
        confidence -= 0.05;
    // Hidden elements: no penalty (every page has them)
    return Math.max(0, confidence);
}
/**
 * Render the diff and confidence as a markdown section appended to tool responses.
 * Truncates text entries to 60 chars and caps display at 5 items per category.
 *
 * @param diff - The computed diff result
 * @param confidence - Confidence score from calculateConfidence
 * @param state - Optional post-state for shadow DOM/iframe annotations
 * @returns Markdown-formatted diff section string
 */
function formatDiffSection(diff, confidence, state) {
    let label = `**Page diff** (confidence: ${Math.round(confidence * 100)}%)`;
    if (state && (state.shadowRootCount > 0 || state.iframeCount > 0)) {
        label += ' (partial — shadow DOM/iframes present)';
    }
    const parts = ['\n\n---', label];
    if (diff.countDelta !== 0) {
        parts.push(`Elements: ${diff.countDelta > 0 ? '+' : ''}${diff.countDelta}`);
    }
    if (diff.added.length > 0) {
        const shown = diff.added.slice(0, 5);
        parts.push(`Added text: ${shown.map(t => `"${t.length > 60 ? t.slice(0, 57) + '...' : t}"`).join(', ')}${diff.added.length > 5 ? ` (+${diff.added.length - 5} more)` : ''}`);
    }
    if (diff.removed.length > 0) {
        const shown = diff.removed.slice(0, 5);
        parts.push(`Removed text: ${shown.map(t => `"${t.length > 60 ? t.slice(0, 57) + '...' : t}"`).join(', ')}${diff.removed.length > 5 ? ` (+${diff.removed.length - 5} more)` : ''}`);
    }
    if (diff.added.length === 0 && diff.removed.length === 0 && diff.countDelta === 0) {
        parts.push('No visible changes detected.');
    }
    return parts.join('\n');
}
//# sourceMappingURL=page-diffing.js.map