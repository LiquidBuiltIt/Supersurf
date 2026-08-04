"use strict";
// server/src/experimental/fingerprinting/selector-synthesis.ts
//
// Turn a scored match winner's identity into a CSS selector that re-resolves to it.
// Pure and synchronous — no page access, no store access.
//
// Deliberately conservative: two tiers (html id, then a stable attribute) and
// `null` otherwise. Class names are NOT used — hashed/CSS-module tokens dominate
// real apps, so a class selector is neither stable across deploys nor unique on
// the page. A `null` answer is honest; the caller falls back to coordinates.
Object.defineProperty(exports, "__esModule", { value: true });
exports.selectorFromHit = selectorFromHit;
/**
 * Attributes worth building a selector from, in descending order of trust.
 * Mirrors the `STABLE` allow-list in page-scripts.ts (those are the only
 * attributes the fingerprint ever captures), ordered test-hook-first because a
 * `data-testid` is authored to be stable while a `title` is authored for humans.
 */
const ATTR_TRUST_ORDER = [
    'data-testid', 'data-test-id', 'data-test', 'data-automation-id',
    'data-id', 'data-key', 'data-item-id', 'data-qa', 'data-cy',
    'name', 'aria-label', 'placeholder', 'alt', 'title',
];
/** Escape a value for use inside a double-quoted CSS attribute selector. */
function escapeAttrValue(value) {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
/**
 * Build a selector for the element a `ScoreHit` describes, or `null` when the
 * hit carries nothing trustworthy enough to select on.
 */
function selectorFromHit(hit) {
    const tag = hit.tag || '*';
    if (hit.htmlId) {
        // CSS ident cannot start with a digit; the attribute form always can.
        return /^\d/.test(hit.htmlId)
            ? `${tag}[id="${escapeAttrValue(hit.htmlId)}"]`
            : `${tag}#${hit.htmlId}`;
    }
    const attrs = hit.attrs || {};
    for (const key of ATTR_TRUST_ORDER) {
        const value = attrs[key];
        if (value)
            return `${tag}[${key}="${escapeAttrValue(value)}"]`;
    }
    return null;
}
//# sourceMappingURL=selector-synthesis.js.map