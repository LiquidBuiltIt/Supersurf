/**
 * Targeted tool tips — contextual hints appended to tool responses
 * when an agent uses a tool in a way that a better-suited tool handles.
 *
 * Each tip has a priority (lower = higher priority). When multiple tips
 * match, only the highest-priority tip is returned.
 *
 * @module tips
 */

interface TipRule {
  id: string;
  priority: number;
  tool: string;
  match: (params: Record<string, unknown>, result: string, error?: string) => boolean;
  message: string;
}

/** Max consecutive firings per (session, tool, tip_id) before suppression kicks in. */
const SUPPRESS_AFTER = 3;

// session_id -> (`${tool}:${tip_id}` -> consecutive firing count)
const tipCounters = new Map<string, Map<string, number>>();

function getSessionCounters(sessionId: string): Map<string, number> {
  let s = tipCounters.get(sessionId);
  if (!s) {
    s = new Map();
    tipCounters.set(sessionId, s);
  }
  return s;
}

export function clearTipCounters(sessionId: string): void {
  tipCounters.delete(sessionId);
}

function getEvalCode(params: Record<string, unknown>): string {
  return String(params.expression ?? params.script ?? params.function ?? '');
}

function hasMutation(code: string): boolean {
  const c = code.toLowerCase();
  return c.includes('.click()') || (c.includes('.value') && /\.value\s*=/.test(code)) ||
    c.includes('scrollinto') || c.includes('scrollby') || c.includes('scrollto') ||
    c.includes('.focus()') || c.includes('.select()') || c.includes('dispatchevent') ||
    c.includes('window.location') || c.includes('document.location') ||
    c.includes('getboundingclientrect');
}

const TIPS: TipRule[] = [
  {
    id: 'eval-click-to-interact',
    priority: 10,
    tool: 'browser_evaluate',
    match: (params) => {
      const code = getEvalCode(params).toLowerCase();
      return code.includes('.click()') || code.includes('click(');
    },
    message:
      'Tip: browser_interact supports text-based clicking — use selector: \'button:has-text("Submit")\' ' +
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
    message:
      'Tip: browser_interact dispatches real CDP input events (mouse, keyboard) that are indistinguishable ' +
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
    message:
      'Tip: browser_interact has scroll_into_view, scroll_by, and scroll_to actions — no JS needed.',
  },
  {
    id: 'eval-value-to-fill-form',
    priority: 25,
    tool: 'browser_evaluate',
    match: (params) => {
      const code = getEvalCode(params);
      return code.includes('.value') && /\.value\s*=/.test(code);
    },
    message:
      'Tip: browser_fill_form sets multiple field values at once with proper change event dispatch for React/Vue.',
  },
  {
    id: 'eval-focus-to-interact',
    priority: 30,
    tool: 'browser_evaluate',
    match: (params) => {
      const code = getEvalCode(params).toLowerCase();
      return (code.includes('.focus()') || code.includes('.select()')) && !code.includes('.click()');
    },
    message:
      'Tip: browser_interact\'s type and click actions auto-focus elements. Use click to focus a field, ' +
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
    message:
      'Tip: browser_navigate action=\'url\' handles navigation with proper page load waiting and status detection.',
  },
  {
    id: 'eval-queryselector-to-lookup',
    priority: 50,
    tool: 'browser_evaluate',
    match: (params) => {
      const code = getEvalCode(params).toLowerCase();
      return (code.includes('queryselector') || code.includes('getelementby')) && !hasMutation(getEvalCode(params));
    },
    message:
      'Tip: browser_lookup finds elements by visible text and returns selectors + coordinates you can pass ' +
      'directly to browser_interact. browser_snapshot returns the full accessibility tree with form field metadata.',
  },
  {
    id: 'interact-no-tab-attached',
    priority: 5,
    tool: 'browser_interact',
    match: (_params, _result, error) => !!error && /no tab attached/i.test(error),
    message:
      'Tip: No tab is attached. Use browser_tabs action=\'attach\' to attach to a tab before interacting.',
  },
  {
    id: 'interact-not-native-select',
    priority: 10,
    tool: 'browser_interact',
    match: (_params, _result, error) => !!error && /not a <select>/i.test(error),
    message:
      'Tip: This element is a JS-driven dropdown, not a native <select>. Use action: \'select_custom\' instead of \'select_option\'.',
  },
  {
    id: 'interact-element-not-found',
    priority: 15,
    tool: 'browser_interact',
    match: (_params, _result, error) => !!error && /element not found/i.test(error),
    message:
      'Tip: Element not found by CSS selector. Use browser_lookup to find elements by visible text — it returns ' +
      'selectors you can pass to browser_interact. You can also use :has-text("...") in selectors, e.g. button:has-text("Next").',
  },

  // ── screenshot tip ──

  {
    id: 'screenshot-inline-param',
    priority: 10,
    tool: 'browser_take_screenshot',
    match: () => true,
    message:
      'Tip: browser_interact, browser_navigate, and browser_fill_form support screenshot: true to capture ' +
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
    message:
      'Tip: browser_extract_content returns clean markdown from the page. Use mode=\'selector\' to target ' +
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
    message:
      'Tip: browser_lookup returns element coordinates (x, y, width, height) along with selectors. ' +
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
    message:
      'Tip: browser_get_element_styles returns computed + matched CSS rules like the DevTools Styles panel. ' +
      'Supports pseudo-state forcing and property filtering.',
  },

];

export function getTip(
  tool: string,
  params: Record<string, unknown>,
  result: 'ok' | 'error',
  error?: string,
  sessionId?: string
): string | null {
  let best: TipRule | null = null;
  const matched: TipRule[] = [];

  for (const rule of TIPS) {
    if (rule.tool !== tool) continue;
    if (rule.match(params, result, error)) {
      matched.push(rule);
      if (!best || rule.priority < best.priority) {
        best = rule;
      }
    }
  }

  // Without a session context, behave as a pure function (no suppression).
  if (!sessionId) return best?.message ?? null;

  // Update counters for every tip rule bound to this tool: increment on match,
  // reset on miss. Reset is per-tip — so tip A firing doesn't reset tip B.
  const counters = getSessionCounters(sessionId);
  const matchedIds = new Set(matched.map((r) => r.id));
  for (const rule of TIPS) {
    if (rule.tool !== tool) continue;
    const key = `${tool}:${rule.id}`;
    if (matchedIds.has(rule.id)) {
      counters.set(key, (counters.get(key) ?? 0) + 1);
    } else {
      counters.set(key, 0);
    }
  }

  if (!best) return null;
  const count = counters.get(`${tool}:${best.id}`) ?? 0;
  if (count > SUPPRESS_AFTER) return null;
  return best.message;
}
