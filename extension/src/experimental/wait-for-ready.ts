/**
 * @module experimental/wait-for-ready
 *
 * Detects when the DOM has stabilized after navigation or dynamic content loads.
 * Uses a MutationObserver with a debounce timer: resolves once no mutations
 * occur within `stabilityMs` milliseconds.
 *
 * CONSTRAINT: No imports, no closures -- injected via `executeScript({ func })`.
 *
 * Key exports:
 * - {@link waitForDOMStable} — injectable function
 */

/**
 * Wait for the DOM to stop mutating. Each mutation resets the debounce timer.
 * Resolves once `stabilityMs` elapses with no childList/subtree changes.
 * @param stabilityMs - Quiet period required before declaring stability (default 300ms)
 * @returns Always resolves `{ stable: true }` (never rejects)
 */
export function waitForDOMStable(stabilityMs: number = 300): Promise<{ stable: boolean }> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;

    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        observer.disconnect();
        resolve({ stable: true });
      }, stabilityMs);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Initial timer — resolves if no mutations happen within stabilityMs
    timer = setTimeout(() => {
      observer.disconnect();
      resolve({ stable: true });
    }, stabilityMs);
  });
}
