/**
 * @module experimental/capture-page-state
 *
 * Self-contained DOM snapshot function injected into the page via
 * `chrome.scripting.executeScript({ func })`. Counts visible/hidden elements,
 * shadow roots, iframes, and extracts truncated visible text for diffing.
 * Descends into OPEN shadow roots (breadth-first, light DOM first) so
 * shadow-heavy pages (web-component-based sites) are no longer undercounted.
 * Closed shadow roots remain unreachable — `el.shadowRoot` is `null` for
 * them, and the walk silently skips (matches the canonical walk in
 * `shared/dom/shadow-walker.ts`).
 *
 * CONSTRAINT: No imports, no closures over outer scope -- `executeScript({ func })`
 * serializes the function via `Function.prototype.toString()` and runs it in a
 * fresh page context. Nested function declarations ARE included in that
 * serialization (they're part of this function's own source text), so the
 * per-element helper below is fine — but nothing may reference a sibling
 * top-level export or an import binding.
 *
 * Key exports:
 * - {@link capturePageState} — injectable function
 * - {@link PageState} — return type
 */

/** Snapshot of the page DOM at capture time, used for page diffing.
 *  SYNC: mirrored in server/src/experimental/page-diffing.ts */
export interface PageState {
  /** Count of visible, non-zero-dimension elements. */
  elementCount: number;
  /** Deduplicated set of visible text snippets (truncated to 200 chars each). */
  textContent: string[];
  shadowRootCount: number;
  iframeCount: number;
  /** Iframes that pass visibility + dimension checks (excludes tracking pixels). */
  visibleIframeCount: number;
  /** Elements hidden via display:none, visibility:hidden, or opacity:0. */
  hiddenElementCount: number;
  /** Total elements in the DOM (visible + hidden). */
  pageElementCount: number;
  /** Form field values keyed by name, id, or positional fallback. */
  formValues: Record<string, string>;
}

/**
 * Walk the DOM (light tree, then breadth-first through open shadow roots),
 * classify elements as visible/hidden, and extract text.
 * Skips BODY/HTML for innerText to avoid O(n^2) re-traversal.
 * @returns Snapshot of element counts and visible text content
 */
export function capturePageState(mode: 'document' | 'viewport' = 'document'): PageState {
  let shadowRootCount = 0;
  let iframeCount = 0;
  let visibleIframeCount = 0;
  let hiddenElementCount = 0;
  let elementCount = 0;
  let pageElementCount = 0;
  let formIndex = 0;
  const textSet = new Set<string>();
  const formValues: Record<string, string> = {};
  // BFS queue of shadow roots discovered while walking each level.
  const shadowQueue: ShadowRoot[] = [];

  // Processes one root's element list (document, or a shadow root's contents).
  // Nested function declarations are part of capturePageState's own source
  // text, so they survive Function.prototype.toString() serialization.
  function processElements(elements: ArrayLike<Element>): void {
    pageElementCount += elements.length;

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];

      // el.shadowRoot is null for closed roots — degrades silently, no throw.
      if (el.shadowRoot) {
        shadowRootCount++;
        shadowQueue.push(el.shadowRoot);
      }
      if (el.tagName === 'IFRAME') iframeCount++;

      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        hiddenElementCount++;
        continue;
      }

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      // In viewport mode, skip elements outside the visible viewport
      if (mode === 'viewport') {
        const vh = window.innerHeight;
        const vw = window.innerWidth;
        if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
      }

      elementCount++;
      if (el.tagName === 'IFRAME') visibleIframeCount++;

      // Extract form field values for diffing
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        const formEl = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        let val = formEl.value;
        if ((formEl as HTMLInputElement).type === 'checkbox' || (formEl as HTMLInputElement).type === 'radio') {
          val = (formEl as HTMLInputElement).checked ? 'checked' : 'unchecked';
        }
        if ((formEl as HTMLInputElement).type === 'password') {
          val = val ? '••••' : '';
        }
        if (tag === 'SELECT') {
          const selectEl = formEl as HTMLSelectElement;
          val = selectEl.options?.[selectEl.selectedIndex]?.text || selectEl.value;
        }
        if (val !== undefined && val !== '') {
          const key = formEl.name || formEl.id || `${tag.toLowerCase()}[${formIndex}]`;
          formValues[key] = val.substring(0, 500);
        }
        formIndex++;
      }

      // Extract visible text via innerText (captures nested changes)
      // Skip body/html — too expensive
      if (tag !== 'BODY' && tag !== 'HTML' && (el as HTMLElement).innerText) {
        const text = (el as HTMLElement).innerText.substring(0, 200).trim();
        if (text.length > 0) {
          textSet.add(text);
        }
      }
    }
  }

  // Light DOM first, then BFS through open shadow roots discovered along the way.
  processElements(document.querySelectorAll('*'));
  while (shadowQueue.length) {
    const root = shadowQueue.shift() as ShadowRoot;
    processElements(root.querySelectorAll('*'));
  }

  return {
    elementCount,
    textContent: Array.from(textSet),
    shadowRootCount,
    iframeCount,
    visibleIframeCount,
    hiddenElementCount,
    pageElementCount,
    formValues,
  };
}
