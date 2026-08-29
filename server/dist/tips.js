"use strict";
/**
 * Targeted tool tips — contextual hints appended to tool responses
 * when an agent uses a tool in a way that a better-suited tool handles.
 *
 * Each tip has a priority (lower = higher priority). When multiple tips
 * match, only the highest-priority tip is returned.
 *
 * @module tips
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearTipCounters = clearTipCounters;
exports.getTip = getTip;
const trail_1 = require("./playbooks/trail");
const index_1 = require("./experimental/index");
/** Max consecutive firings per (session, tool, tip_id) before suppression kicks in. */
const SUPPRESS_AFTER = 3;
/** Tip ids that fire at most once per session, regardless of how often they match. */
const ONCE_PER_SESSION_IDS = new Set(['playbooks-milestone', 'playbooks-repeat']);
// session_id -> (`${tool}:${tip_id}` -> consecutive firing count). Wildcard-tool
// rules share a `*` bucket instead of one per matched tool.
const tipCounters = new Map();
// session_id -> set of once-per-session tip ids already fired this session.
const firedOnce = new Map();
function getSessionCounters(sessionId) {
    let s = tipCounters.get(sessionId);
    if (!s) {
        s = new Map();
        tipCounters.set(sessionId, s);
    }
    return s;
}
function clearTipCounters(sessionId) {
    tipCounters.delete(sessionId);
    firedOnce.delete(sessionId);
}
/** `${tool}:${type}:${url}` — identifies an entry's "shape" for repeat-sequence detection. */
function signature(e) {
    const url = e.tool === 'browser_navigate' ? e.params?.url : e.url;
    return `${e.tool}:${e.type}:${url ?? ''}`;
}
/**
 * True when the trail's last 3 entries repeat an earlier, non-overlapping
 * 3-entry window, and that window touches at least 2 distinct tools (so a
 * plain scroll/scroll/scroll streak doesn't count).
 */
function hasRepeatedWindow() {
    const size = trail_1.actionTrail.size();
    if (size < 6)
        return false;
    const { entries } = trail_1.actionTrail.tail(size);
    const n = entries.length;
    const last = entries.slice(n - 3, n);
    if (new Set(last.map((e) => e.tool)).size < 2)
        return false;
    const lastSig = last.map(signature);
    for (let start = 0; start <= n - 6; start++) {
        const w = entries.slice(start, start + 3).map(signature);
        if (w[0] === lastSig[0] && w[1] === lastSig[1] && w[2] === lastSig[2])
            return true;
    }
    return false;
}
// SuperSurf never writes a playbook file, so none of these can point at a save
// command — there deliberately is no write action. They point at `history`
// instead, which is where the selectors that actually worked live.
const PLAYBOOKS_MILESTONE_ON = 'Tip: 8 actions recorded this session. `playbooks history` lists them with ids and the ' +
    'selectors that actually worked — write them into a `~/.supersurf/playbooks/<name>.playbook.js` ' +
    'script with your own file tools, then replay it with `playbooks run`.';
const PLAYBOOKS_REPEAT_ON = 'Tip: the last few actions repeat an earlier sequence. `playbooks history` has the selectors ' +
    'that worked — save them once as a `<name>.playbook.js` script and replay with `playbooks run`.';
const PLAYBOOKS_GATE_OFF = "Tip: this session's actions could be replayed as a playbook script. Enable the `fingerprinting` " +
    'experiment in ~/.supersurf/config.json and restart the daemon to unlock `playbooks run`.';
function playbooksTipMessage(onMessage) {
    return index_1.experimentRegistry.isEnabled('fingerprinting') ? onMessage : PLAYBOOKS_GATE_OFF;
}
function getEvalCode(params) {
    return String(params.expression ?? params.script ?? params.function ?? '');
}
function hasMutation(code) {
    const c = code.toLowerCase();
    return c.includes('.click()') || (c.includes('.value') && /\.value\s*=/.test(code)) ||
        c.includes('scrollinto') || c.includes('scrollby') || c.includes('scrollto') ||
        c.includes('.focus()') || c.includes('.select()') || c.includes('dispatchevent') ||
        c.includes('window.location') || c.includes('document.location') ||
        c.includes('getboundingclientrect');
}
const TIPS = [
    {
        id: 'eval-click-to-interact',
        priority: 10,
        tool: 'browser_evaluate',
        match: (params) => {
            const code = getEvalCode(params).toLowerCase();
            return code.includes('.click()') || code.includes('click(');
        },
        message: 'Tip: browser_interact supports text-based clicking — use selector: \'button:has-text("Submit")\' ' +
            'instead of JS .click(). This produces real CDP input events that are indistinguishable from human clicks.',
    },
    {
        id: 'eval-dispatchevent-to-interact',
        priority: 15,
        tool: 'browser_evaluate',
        match: (params) => {
            const code = getEvalCode(params).toLowerCase();
            return code.includes('dispatchevent');
        },
        message: 'Tip: browser_interact dispatches real CDP input events (mouse, keyboard) that are indistinguishable ' +
            'from user actions. JS dispatchEvent is synthetic and detectable by anti-bot systems.',
    },
    {
        id: 'eval-scroll-to-interact',
        priority: 20,
        tool: 'browser_evaluate',
        match: (params) => {
            const code = getEvalCode(params).toLowerCase();
            return code.includes('scrollintoview') || code.includes('scrollby') || code.includes('scrollto');
        },
        message: 'Tip: browser_interact has scroll_into_view, scroll_by, and scroll_to actions — no JS needed.',
    },
    {
        id: 'eval-value-to-fill-form',
        priority: 25,
        tool: 'browser_evaluate',
        match: (params) => {
            const code = getEvalCode(params);
            return code.includes('.value') && /\.value\s*=/.test(code);
        },
        message: 'Tip: browser_fill_form sets multiple field values at once with proper change event dispatch for React/Vue.',
    },
    {
        id: 'eval-focus-to-interact',
        priority: 30,
        tool: 'browser_evaluate',
        match: (params) => {
            const code = getEvalCode(params).toLowerCase();
            return (code.includes('.focus()') || code.includes('.select()')) && !code.includes('.click()');
        },
        message: 'Tip: browser_interact\'s type and click actions auto-focus elements. Use click to focus a field, ' +
            'or type with a selector to focus-and-type in one action.',
    },
    {
        id: 'eval-location-to-navigate',
        priority: 35,
        tool: 'browser_evaluate',
        match: (params) => {
            const code = getEvalCode(params).toLowerCase();
            return code.includes('window.location') || code.includes('document.location');
        },
        message: 'Tip: browser_navigate action=\'url\' handles navigation with proper page load waiting and status detection.',
    },
    {
        id: 'eval-queryselector-to-lookup',
        priority: 50,
        tool: 'browser_evaluate',
        match: (params) => {
            const code = getEvalCode(params).toLowerCase();
            return (code.includes('queryselector') || code.includes('getelementby')) && !hasMutation(getEvalCode(params));
        },
        message: 'Tip: browser_lookup finds elements by visible text and returns selectors + coordinates you can pass ' +
            'directly to browser_interact. browser_snapshot returns the full accessibility tree with form field metadata.',
    },
    {
        id: 'interact-no-tab-attached',
        priority: 5,
        tool: 'browser_interact',
        match: (_params, _result, error) => !!error && /no tab attached/i.test(error),
        message: 'Tip: No tab is attached. Use browser_tabs action=\'attach\' to attach to a tab before interacting.',
    },
    {
        id: 'interact-not-native-select',
        priority: 10,
        tool: 'browser_interact',
        match: (_params, _result, error) => !!error && /not a <select>/i.test(error),
        message: 'Tip: This element is a JS-driven dropdown, not a native <select>. Use action: \'select_custom\' instead of \'select_option\'.',
    },
    {
        id: 'interact-element-not-found',
        priority: 15,
        tool: 'browser_interact',
        match: (_params, _result, error) => !!error && /element not found/i.test(error),
        message: 'Tip: Element not found by CSS selector. Use browser_lookup to find elements by visible text — it returns ' +
            'selectors you can pass to browser_interact. You can also use :has-text("...") in selectors, e.g. button:has-text("Next").',
    },
    // ── screenshot tip ──
    {
        id: 'screenshot-inline-param',
        priority: 10,
        tool: 'browser_take_screenshot',
        match: () => true,
        message: 'Tip: browser_interact, browser_navigate, and browser_fill_form support screenshot: true to capture ' +
            'a screenshot inline with the action — saves a separate tool call.',
    },
    // ── additional evaluate tips ──
    {
        id: 'eval-innerhtml-to-extract',
        priority: 22,
        tool: 'browser_evaluate',
        match: (params) => {
            const code = getEvalCode(params).toLowerCase();
            return code.includes('innerhtml') || code.includes('outerhtml');
        },
        message: 'Tip: browser_extract_content returns clean markdown from the page. Use mode=\'selector\' to target ' +
            'a specific element. No JS needed for content extraction.',
    },
    {
        id: 'eval-rect-to-lookup',
        priority: 18,
        tool: 'browser_evaluate',
        match: (params) => {
            const code = getEvalCode(params).toLowerCase();
            return code.includes('getboundingclientrect') && !code.includes('.click()');
        },
        message: 'Tip: browser_lookup returns element coordinates (x, y, width, height) along with selectors. ' +
            'No JS needed for position data.',
    },
    {
        id: 'eval-computedstyle-to-styles',
        priority: 32,
        tool: 'browser_evaluate',
        match: (params) => {
            const code = getEvalCode(params).toLowerCase();
            return code.includes('getcomputedstyle');
        },
        message: 'Tip: browser_get_element_styles returns computed + matched CSS rules like the DevTools Styles panel. ' +
            'Supports pseudo-state forcing and property filtering.',
    },
    // ── playbooks tips (wildcard — any tool except `playbooks` itself) ──
    {
        id: 'playbooks-milestone',
        priority: 1,
        tool: '*',
        match: () => trail_1.actionTrail.size() >= 8,
        message: () => playbooksTipMessage(PLAYBOOKS_MILESTONE_ON),
    },
    {
        id: 'playbooks-repeat',
        priority: 2,
        tool: '*',
        match: () => hasRepeatedWindow(),
        message: () => playbooksTipMessage(PLAYBOOKS_REPEAT_ON),
    },
];
/** True if `rule` applies to `tool` — wildcard rules match every tool except `playbooks`. */
function ruleAppliesTo(rule, tool) {
    if (rule.tool === '*')
        return tool !== 'playbooks';
    return rule.tool === tool;
}
function getTip(tool, params, result, error, sessionId) {
    const fired = sessionId ? firedOnce.get(sessionId) : undefined;
    let best = null;
    const matched = [];
    for (const rule of TIPS) {
        if (!ruleAppliesTo(rule, tool))
            continue;
        if (rule.match(params, result, error)) {
            matched.push(rule);
            if (ONCE_PER_SESSION_IDS.has(rule.id) && fired?.has(rule.id))
                continue;
            if (!best || rule.priority < best.priority) {
                best = rule;
            }
        }
    }
    const resolve = (rule) => (typeof rule.message === 'function' ? rule.message() : rule.message);
    // Without a session context, behave as a pure function (no suppression).
    if (!sessionId)
        return best ? resolve(best) : null;
    // Update counters for every tip rule bound to this tool: increment on match,
    // reset on miss. Reset is per-tip — so tip A firing doesn't reset tip B.
    // Wildcard rules share a `*` bucket rather than one per matched tool.
    const counters = getSessionCounters(sessionId);
    const matchedIds = new Set(matched.map((r) => r.id));
    for (const rule of TIPS) {
        if (!ruleAppliesTo(rule, tool))
            continue;
        const counterTool = rule.tool === '*' ? '*' : tool;
        const key = `${counterTool}:${rule.id}`;
        if (matchedIds.has(rule.id)) {
            counters.set(key, (counters.get(key) ?? 0) + 1);
        }
        else {
            counters.set(key, 0);
        }
    }
    if (!best)
        return null;
    const counterTool = best.tool === '*' ? '*' : tool;
    const count = counters.get(`${counterTool}:${best.id}`) ?? 0;
    if (count > SUPPRESS_AFTER)
        return null;
    if (ONCE_PER_SESSION_IDS.has(best.id)) {
        let s = firedOnce.get(sessionId);
        if (!s) {
            s = new Set();
            firedOnce.set(sessionId, s);
        }
        s.add(best.id);
    }
    return resolve(best);
}
//# sourceMappingURL=tips.js.map