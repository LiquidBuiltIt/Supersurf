/**
 * @module utils/unwrap
 *
 * Counteracts bot-detection libraries that monkey-patch DOM query methods
 * (querySelector, getComputedStyle, etc.) to detect automation frameworks.
 * When agent code references these methods, the wrapper temporarily restores
 * native implementations sourced from a hidden iframe, executes the code,
 * then restores the page's patched versions.
 *
 * Key exports:
 * - {@link shouldUnwrap} — check if code references any wrapped methods
 * - {@link wrapWithUnwrap} — wrap user code with native-method restoration
 *
 * Adapted from Blueprint MCP (Apache 2.0)
 */

/**
 * DOM methods commonly monkey-patched by bot detection libraries
 * (e.g. Akamai, PerimeterX, Cloudflare Turnstile).
 */
const WRAPPED_METHODS = [
  'document.querySelector',
  'document.querySelectorAll',
  'document.getElementById',
  'document.getElementsByClassName',
  'document.getElementsByTagName',
  'Element.prototype.querySelector',
  'Element.prototype.querySelectorAll',
  'Element.prototype.getAttribute',
  'Element.prototype.setAttribute',
  'Element.prototype.getBoundingClientRect',
  'window.getComputedStyle',
];

/**
 * Check whether the given code string references any commonly wrapped DOM methods.
 * Uses simple substring matching on the method's short name (e.g. "querySelector").
 */
export function shouldUnwrap(code: string): boolean {
  return WRAPPED_METHODS.some((method) => {
    const shortName = method.split('.').pop()!;
    return code.includes(shortName);
  });
}

/**
 * Wrap user code in an IIFE that temporarily replaces monkey-patched DOM methods
 * with native versions obtained from a hidden iframe's contentDocument/contentWindow.
 * The iframe is created, methods are swapped, user code executes, then originals
 * are restored in a finally block to leave the page's patches intact.
 *
 * @param userCode - Raw JavaScript string to execute in the page context
 * @returns Wrapped code string, or the original if no wrapped methods are referenced
 */
export function wrapWithUnwrap(userCode: string): string {
  if (!shouldUnwrap(userCode)) return userCode;

  return `
(function() {
  // Save potentially wrapped methods
  const _saved = {};
  const _iframe = document.createElement('iframe');
  _iframe.style.display = 'none';
  document.body.appendChild(_iframe);
  const _nativeDoc = _iframe.contentDocument;
  const _nativeWin = _iframe.contentWindow;

  // Restore native methods
  if (_nativeDoc) {
    _saved.querySelector = document.querySelector;
    document.querySelector = _nativeDoc.querySelector.bind(document);
    _saved.querySelectorAll = document.querySelectorAll;
    document.querySelectorAll = _nativeDoc.querySelectorAll.bind(document);
  }
  if (_nativeWin) {
    _saved.getComputedStyle = window.getComputedStyle;
    window.getComputedStyle = _nativeWin.getComputedStyle.bind(window);
  }

  let result;
  try {
    result = eval(${JSON.stringify(userCode)});
  } finally {
    // Restore wrapped methods
    if (_saved.querySelector) document.querySelector = _saved.querySelector;
    if (_saved.querySelectorAll) document.querySelectorAll = _saved.querySelectorAll;
    if (_saved.getComputedStyle) window.getComputedStyle = _saved.getComputedStyle;
    _iframe.remove();
  }
  return result;
})()
  `.trim();
}
