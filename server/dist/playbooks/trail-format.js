"use strict";
/**
 * Rendering for the in-memory action trail.
 *
 * Split out of the old `playbooks/format.ts` when the JSON playbook format was
 * deleted. `formatHistory` is the only part of that module that survived, because
 * `playbooks {action:"history"}` reads the trail singleton, never the disk — it is
 * how a script author reads back the selectors a working run actually used.
 *
 * @module playbooks/trail-format
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatHistory = formatHistory;
const MARK = { ok: 'ok', warn: '⚠', error: '✗' };
/** Shorten a URL to host + path for the divider line. */
function routeLabel(url) {
    if (!url)
        return '';
    try {
        const u = new URL(url);
        return `${u.host}${u.pathname}`.replace(/\/$/, '') || u.host;
    }
    catch {
        return url;
    }
}
/**
 * The thing a human recognizes the action by: the agent's handle name when it
 * gave one, else the raw selector, else the action verb's own detail.
 */
function targetLabel(e) {
    const p = e.params;
    const name = typeof p.name === 'string' ? p.name : undefined;
    const selector = typeof p.selector === 'string' ? p.selector : undefined;
    const key = typeof p.key === 'string' ? p.key : undefined;
    const url = typeof p.url === 'string' ? p.url : undefined;
    return name ?? selector ?? key ?? url ?? '';
}
function formatHistory(entries, total, offset) {
    if (total === 0)
        return 'No actions recorded yet in this session.';
    const first = entries[0]?.id;
    const last = entries[entries.length - 1]?.id;
    const header = `actions ${first}-${last} of ${total}` +
        (offset + entries.length < total ? `  (older: offset ${offset + entries.length})` : '');
    const lines = [header, ''];
    let currentRoute = null;
    for (const e of entries) {
        const route = routeLabel(e.url);
        if (route && route !== currentRoute) {
            lines.push(`── ${route} ──`);
            currentRoute = route;
        }
        const mark = MARK[e.outcome];
        const target = targetLabel(e);
        const detail = e.outcome === 'error' ? `${mark} ${e.message}` : mark;
        lines.push(`#${e.id} ${e.type.padEnd(10)} ${target.padEnd(28)} ${detail}`.trimEnd());
    }
    return lines.join('\n');
}
//# sourceMappingURL=trail-format.js.map