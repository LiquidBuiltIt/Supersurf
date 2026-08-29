"use strict";
/**
 * The playbook client surface — every method the `supersurf` object exposes and
 * the parameter names its arguments travel under.
 *
 * IMPORTANT: this module must have ZERO imports. It is loaded by the sandbox
 * child process, which must not pull the server (logger, config, transports,
 * anything under `tools/`) into its address space. Keep it pure data plus one
 * pure function.
 *
 * This table does NOT know which MCP tool a method reaches. Per spec Addendum
 * A, `onCommand(method, params)` forwards verbatim and the client-method →
 * MCP-tool mapping is a Plan 3 deliverable (`server/src/playbooks/command-map.ts`).
 * Do not add a `tool:` field here.
 *
 * Deliberately absent, per spec §7.7: `connect` / `disconnect` (the runner owns
 * them), every profile tool (capability escalation), and `playbook()` (nesting,
 * deferred to a later version).
 *
 * @module security/sandbox/methods
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PERMISSION_GATED = exports.METHODS = void 0;
exports.buildParams = buildParams;
/**
 * Client path → method spec. Dotted keys become nested objects on the client
 * (`tabs.list` → `supersurf.tabs.list`).
 *
 * Namespaced passthroughs take a single `opts` object — spec §7.7: "the
 * signature is the underlying tool's rawResult parameter object, with the
 * action enum unpacked into a method name".
 */
exports.METHODS = {
    // ── Navigation ──
    goto: { params: ['url'] },
    back: { params: [] },
    forward: { params: [] },
    reload: { params: [] },
    // ── Interaction (browser_interact's 15 action types, unpacked) ──
    click: { params: ['selector'] },
    type: { params: ['selector', 'text'] },
    clear: { params: ['selector'] },
    pressKey: { params: ['key'] },
    hover: { params: ['selector'] },
    wait: { params: ['msOrSelector'] },
    mouseMove: { params: ['x', 'y'] },
    mouseClick: { params: ['x', 'y', 'opts'] },
    scrollTo: { params: ['selector'] },
    scrollBy: { params: ['x', 'y'] },
    scrollIntoView: { params: ['selector'] },
    selectOption: { params: ['selector', 'value'] },
    selectCustom: { params: ['selector', 'value'] },
    upload: { params: ['selector', 'files'] },
    forcePseudoState: { params: ['selector', 'states'] },
    // ── Content ──
    snapshot: { params: [] },
    lookup: { params: ['query'] },
    extract: { params: ['opts'] },
    styles: { params: ['selector', 'opts'] },
    screenshot: { params: ['opts'] },
    // ── Verification — boolean, never throwing on a false result ──
    seeText: { params: ['text'], returnsBoolean: true },
    seeElement: { params: ['selector'], returnsBoolean: true },
    // ── Forms ──
    drag: { params: ['from', 'to'] },
    fill: { params: ['fields'] },
    // The env var NAME crosses the pipe; the child has no environment, so the
    // value resolves in the parent. Sandbox and feature agree by construction.
    secureFill: { params: ['selector', 'envName'] },
    // ── Namespaced passthroughs ──
    'tabs.list': { params: ['opts'] },
    'tabs.new': { params: ['opts'] },
    'tabs.attach': { params: ['opts'] },
    'tabs.close': { params: ['opts'] },
    'net.requests': { params: ['opts'] },
    'net.console': { params: ['opts'] },
    'storage.get': { params: ['opts'] },
    'storage.set': { params: ['opts'] },
    'storage.delete': { params: ['opts'] },
    'storage.clear': { params: ['opts'] },
    'storage.list': { params: ['opts'] },
    'window.resize': { params: ['opts'] },
    'window.close': { params: [] },
    'window.minimize': { params: [] },
    'window.maximize': { params: [] },
    'dialog.view': { params: [] },
    'dialog.accept': { params: ['opts'] },
    'dialog.dismiss': { params: [] },
    pdf: { params: ['opts'] },
    download: { params: ['opts'] },
    perf: { params: [] },
    extensions: { params: [] },
    // ── Permission-gated ──
    evaluate: { params: ['code'] },
};
/** Client path → the permission that must appear in `meta.permissions` for the
 *  method to be BUILT. Absent permission means absent method — there is no
 *  runtime check to bypass. */
exports.PERMISSION_GATED = {
    evaluate: 'eval',
};
/**
 * Turn a call's positional arguments into the named `params` object that
 * crosses the pipe. An argument that is `undefined` produces an ABSENT KEY —
 * never `null`, never a placeholder. Extra arguments beyond the declared
 * parameter list are dropped.
 */
function buildParams(spec, args) {
    const out = {};
    for (let i = 0; i < spec.params.length; i++) {
        if (args[i] !== undefined)
            out[spec.params[i]] = args[i];
    }
    return out;
}
//# sourceMappingURL=methods.js.map