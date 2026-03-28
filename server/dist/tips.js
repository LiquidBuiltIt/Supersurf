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
exports.getTip = getTip;
function getEvalCode(params) {
    return String(params.expression ?? params.script ?? params.function ?? '');
}
function hasMutation(code) {
    const c = code.toLowerCase();
    return c.includes('.click()') || (c.includes('.value') && /\.value\s*=/.test(code)) ||
        c.includes('scrollinto') || c.includes('scrollby') || c.includes('scrollto') ||
        c.includes('.focus()') || c.includes('.select()') || c.includes('dispatchevent') ||
        c.includes('window.location') || c.includes('document.location');
}
const TIPS = [
    {
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
        priority: 20,
        tool: 'browser_evaluate',
        match: (params) => {
            const code = getEvalCode(params).toLowerCase();
            return code.includes('scrollintoview') || code.includes('scrollby') || code.includes('scrollto');
        },
        message: 'Tip: browser_interact has scroll_into_view, scroll_by, and scroll_to actions — no JS needed.',
    },
    {
        priority: 25,
        tool: 'browser_evaluate',
        match: (params) => {
            const code = getEvalCode(params);
            return code.includes('.value') && /\.value\s*=/.test(code);
        },
        message: 'Tip: browser_fill_form sets multiple field values at once with proper change event dispatch for React/Vue.',
    },
    {
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
        priority: 35,
        tool: 'browser_evaluate',
        match: (params) => {
            const code = getEvalCode(params).toLowerCase();
            return code.includes('window.location') || code.includes('document.location');
        },
        message: 'Tip: browser_navigate action=\'url\' handles navigation with proper page load waiting and status detection.',
    },
    {
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
        priority: 5,
        tool: 'browser_interact',
        match: (_params, _result, error) => !!error && /no tab attached/i.test(error),
        message: 'Tip: No tab is attached. Use browser_tabs action=\'attach\' to attach to a tab before interacting.',
    },
    {
        priority: 10,
        tool: 'browser_interact',
        match: (_params, _result, error) => !!error && /not a <select>/i.test(error),
        message: 'Tip: This element is a JS-driven dropdown, not a native <select>. Use action: \'select_custom\' instead of \'select_option\'.',
    },
    {
        priority: 15,
        tool: 'browser_interact',
        match: (_params, _result, error) => !!error && /element not found/i.test(error),
        message: 'Tip: Element not found by CSS selector. Use browser_lookup to find elements by visible text — it returns ' +
            'selectors you can pass to browser_interact. You can also use :has-text("...") in selectors, e.g. button:has-text("Next").',
    },
];
function getTip(tool, params, result, error) {
    let best = null;
    for (const rule of TIPS) {
        if (rule.tool !== tool)
            continue;
        if (best && rule.priority >= best.priority)
            continue;
        if (rule.match(params, result, error)) {
            best = rule;
        }
    }
    return best?.message ?? null;
}
//# sourceMappingURL=tips.js.map