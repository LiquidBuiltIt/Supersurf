/**
 * @module experimental/capture-page-state
 *
 * Self-contained DOM snapshot function injected into the page via
 * `chrome.scripting.executeScript({ func })`. Counts visible/hidden elements,
 * shadow roots, iframes, and extracts truncated visible text for diffing.
 *
 * CONSTRAINT: No imports, no closures -- `executeScript({ func })` serializes
 * the function body and runs it in a fresh page context.
 *
 * Key exports:
 * - {@link capturePageState} — injectable function
 * - {@link PageState} — return type
 */

/** Snapshot of the page DOM at capture time, used for page diffing. */
export interface PageState {
  /** Count of visible, non-zero-dimension elements. */
  elementCount: number;
  /** Deduplicated set of visible text snippets (truncated to 200 chars each). */
  textContent: string[];
  shadowRootCount: number;
  iframeCount: number;
  /** Elements hidden via display:none, visibility:hidden, or opacity:0. */
  hiddenElementCount: number;
  /** Total elements in the DOM (visible + hidden). */
  pageElementCount: number;
}

/**
 * Walk the DOM, classify elements as visible/hidden, and extract text.
 * Skips BODY/HTML for innerText to avoid O(n^2) re-traversal.
 * @returns Snapshot of element counts and visible text content
 */
export function capturePageState(): PageState {
  const allElements = document.querySelectorAll('*');
  const pageElementCount = allElements.length;

  let shadowRootCount = 0;
  let iframeCount = 0;
  let hiddenElementCount = 0;
  let elementCount = 0;
  const textSet = new Set<string>();

  for (let i = 0; i < allElements.length; i++) {
    const el = allElements[i];

    if (el.shadowRoot) shadowRootCount++;
    if (el.tagName === 'IFRAME') iframeCount++;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      hiddenElementCount++;
      continue;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;

    elementCount++;

    // Extract visible text via innerText (captures nested changes)
    // Skip body/html — too expensive
    const tag = el.tagName;
    if (tag !== 'BODY' && tag !== 'HTML' && (el as HTMLElement).innerText) {
      const text = (el as HTMLElement).innerText.substring(0, 200).trim();
      if (text.length > 0) {
        textSet.add(text);
      }
    }
  }

  return {
    elementCount,
    textContent: Array.from(textSet),
    shadowRootCount,
    iframeCount,
    hiddenElementCount,
    pageElementCount,
  };
}
