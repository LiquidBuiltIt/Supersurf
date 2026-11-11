/**
 * Page diffing — compares DOM snapshots before/after interactions to produce
 * a lightweight summary of what changed on the page.
 *
 * When the `page_diffing` experiment is enabled, the server captures a PageState
 * snapshot before each browser_interact call and diffs it against the post-action
 * snapshot. The diff (added/removed text, element count delta) is appended to
 * the tool response along with a confidence score.
 *
 * Confidence scoring applies flat penalties for iframes and very large pages —
 * conditions that reduce snapshot completeness but don't invalidate the diff.
 * Open shadow roots are pierced during capture (see
 * extension/src/experimental/capture-page-state.ts) so they no longer carry a
 * penalty; closed shadow roots remain silently unreachable (no reliable way to
 * detect their presence from script).
 *
 * @module experimental/page-diffing
 *
 * Key exports:
 * - {@link diffSnapshots} — compute added/removed text and element count delta
 * - {@link calculateConfidence} — score how complete the snapshot is (0.0 to 1.0)
 * - {@link formatDiffSection} — render diff + confidence as a markdown section
 */

/** Snapshot of observable page state at a point in time.
 *  SYNC: mirrored in extension/src/experimental/capture-page-state.ts */
export interface PageState {
  elementCount: number;
  textContent: string[];
  shadowRootCount: number;
  iframeCount: number;
  /** Iframes that pass visibility + dimension checks (excludes tracking pixels). */
  visibleIframeCount: number;
  hiddenElementCount: number;
  pageElementCount: number;
  /** Form field values keyed by name, id, or positional fallback. */
  formValues: Record<string, string>;
}

/** Result of comparing two PageState snapshots. */
export interface DiffResult {
  added: string[];
  removed: string[];
  countDelta: number;
  formChanges: Array<{ field: string; from: string; to: string }>;
}

/**
 * Compute the diff between two page snapshots.
 * Uses set-based comparison on textContent arrays to find added/removed strings.
 *
 * @param before - Snapshot taken before the interaction
 * @param after - Snapshot taken after the interaction
 * @returns Added text, removed text, and net element count change
 */
export function diffSnapshots(before: PageState, after: PageState): DiffResult {
  const beforeSet = new Set(before.textContent);
  const afterSet = new Set(after.textContent);

  const added = after.textContent.filter(t => !beforeSet.has(t));
  const removed = before.textContent.filter(t => !afterSet.has(t));
  const countDelta = after.elementCount - before.elementCount;

  // Form value diff (|| {} for backward compat with old extension versions)
  const formChanges: DiffResult['formChanges'] = [];
  const beforeForms = before.formValues || {};
  const afterForms = after.formValues || {};
  const allKeys = new Set([...Object.keys(beforeForms), ...Object.keys(afterForms)]);
  for (const key of allKeys) {
    const from = beforeForms[key] || '';
    const to = afterForms[key] || '';
    if (from !== to) formChanges.push({ field: key, from, to });
  }

  return { added, removed, countDelta, formChanges };
}

/**
 * Score how reliable the diff is based on page complexity.
 * Starts at 1.0 and applies flat penalties:
 * - Iframes present: -0.05 (cross-origin content invisible)
 * - Large page (>5000 elements): -0.05 (snapshot may be incomplete)
 *
 * Shadow DOM carries no penalty: capture pierces open shadow roots (see
 * extension/src/experimental/capture-page-state.ts), so their content is
 * already reflected in elementCount/textContent. Closed shadow roots are
 * still invisible, but there's no reliable way to detect their presence
 * from script to penalize for it specifically.
 *
 * @param state - The post-interaction page snapshot
 * @returns Confidence between 0.0 and 1.0
 */
export function calculateConfidence(state: PageState): number {
  let confidence = 1.0;

  // Flat penalty — iframes reduce visibility but don't invalidate the diff
  if (state.visibleIframeCount > 0) confidence -= 0.05;
  if (state.pageElementCount > 5000) confidence -= 0.05;
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
export function formatDiffSection(diff: DiffResult, confidence: number, state?: PageState, mode?: string): string {
  let label = `**Page diff** (confidence: ${Math.round(confidence * 100)}%)`;
  if (mode === 'viewport') label += ' (viewport only)';
  if (state) {
    const reasons: string[] = [];
    // Open shadow roots are pierced during capture — no longer a partial-capture reason.
    // Closed shadow roots stay invisible, but script has no reliable way to detect them.
    if (state.visibleIframeCount > 0) reasons.push(`iframes (${state.visibleIframeCount} visible)`);
    if (reasons.length > 0) label += ` (partial — ${reasons.join(' + ')} present)`;
  }
  const parts: string[] = ['\n\n---', label];

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

  if (diff.formChanges && diff.formChanges.length > 0) {
    const shown = diff.formChanges.slice(0, 8);
    const lines = shown.map(c => {
      const from = c.from ? `"${c.from.length > 40 ? c.from.slice(0, 37) + '...' : c.from}"` : '(empty)';
      const to = c.to ? `"${c.to.length > 40 ? c.to.slice(0, 37) + '...' : c.to}"` : '(empty)';
      return `  ${c.field}: ${from} \u2192 ${to}`;
    });
    parts.push(`Form changes:\n${lines.join('\n')}${diff.formChanges.length > 8 ? `\n  (+${diff.formChanges.length - 8} more)` : ''}`);
  }

  if (diff.added.length === 0 && diff.removed.length === 0 && diff.countDelta === 0 && (!diff.formChanges || diff.formChanges.length === 0)) {
    parts.push('No visible changes detected.');
  }

  return parts.join('\n');
}
