/**
 * @module pages/changelog-render
 *
 * Pure helpers for the changelog page: version comparison, section slicing,
 * and minimal Markdown rendering. Kept dependency-free and DOM-free so
 * they're easily unit tested — `extension/src/pages/changelog.ts` wires
 * them to `fetch` + the DOM.
 */
/** Parse a semver-ish "x.y.z" string into [major, minor, patch] numbers, or null if unparsable. */
function parseVersion(version) {
    const m = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m)
        return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}
/**
 * Numeric x.y.z comparison: negative if a < b, 0 if equal, positive if a > b.
 * Compares component-by-component (not string order — "3.10.0" > "3.9.0").
 * Unparsable input sorts lower than any parsable version.
 */
export function compareVersions(a, b) {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (!pa && !pb)
        return 0;
    if (!pa)
        return -1;
    if (!pb)
        return 1;
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i])
            return pa[i] - pb[i];
    }
    return 0;
}
/**
 * Sections strictly newer than `from` (exclusive) and no newer than `curr`
 * (inclusive), newest first. `from === null` (missing/unparsable previous
 * version) includes everything up to `curr`.
 */
export function sliceSections(sections, from, curr) {
    return sections
        .filter((s) => (from === null || compareVersions(s.version, from) > 0) && compareVersions(s.version, curr) <= 0)
        .sort((a, b) => compareVersions(b.version, a.version));
}
/**
 * Minimal Markdown -> HTML for a single bullet: escapes everything, then
 * re-enables `**bold**` and `` `code` `` spans. Not a general renderer —
 * matches the two inline conventions CHANGELOG.md bullets actually use.
 */
export function renderBulletHtml(text) {
    const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let html = escape(text);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return html;
}
