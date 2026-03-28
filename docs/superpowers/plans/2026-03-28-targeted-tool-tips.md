# Targeted Tool Tips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Append contextual tips to tool responses when an agent uses a tool in a way that a better-suited tool already handles, nudging agents toward the correct tool without breaking their flow.

**Architecture:** A single `tips.ts` module exports a `getTip()` function that evaluates the tool name, params, result, and error against a registry of tip rules. `BrowserBridge.callTool()` calls `getTip()` after every tool execution and appends any matching tip to the response text. Tips are appended once per response, at most one tip per call (highest priority match wins).

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Create the tip registry module

**Files:**
- Create: `server/src/tips.ts`
- Test: `server/tests/tips.test.ts`

- [ ] **Step 1: Write failing tests for the tip registry**

```typescript
// server/tests/tips.test.ts
import { describe, it, expect } from 'vitest';
import { getTip } from '../src/tips';

describe('getTip', () => {
  // Tip 1: evaluate doing .click() with text matching
  it('returns has-text tip when evaluate does textContent click', () => {
    const tip = getTip('browser_evaluate', {
      expression: `const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Submit')); btn.click();`
    }, 'ok');
    expect(tip).toContain(':has-text(');
    expect(tip).toContain('browser_interact');
  });

  it('returns has-text tip when evaluate does basic click', () => {
    const tip = getTip('browser_evaluate', {
      expression: `document.querySelector('button').click()`
    }, 'ok');
    expect(tip).toContain('browser_interact');
  });

  // Tip 2: evaluate doing scroll
  it('returns scroll tip when evaluate does scrollIntoView', () => {
    const tip = getTip('browser_evaluate', {
      expression: `document.querySelector('#target').scrollIntoView()`
    }, 'ok');
    expect(tip).toContain('scroll_into_view');
  });

  it('returns scroll tip when evaluate does scrollBy', () => {
    const tip = getTip('browser_evaluate', {
      expression: `window.scrollBy(0, 500)`
    }, 'ok');
    expect(tip).toContain('scroll_by');
  });

  // Tip 3: evaluate doing .value =
  it('returns fill_form tip when evaluate sets .value', () => {
    const tip = getTip('browser_evaluate', {
      expression: `document.querySelector('input').value = 'test@example.com'`
    }, 'ok');
    expect(tip).toContain('browser_fill_form');
  });

  it('does not return fill_form tip when reading .value', () => {
    const tip = getTip('browser_evaluate', {
      expression: `document.querySelector('input').value`
    }, 'ok');
    expect(tip).not.toContain('browser_fill_form');
  });

  // Tip 4: evaluate reading DOM
  it('returns lookup tip when evaluate queries DOM without mutating', () => {
    const tip = getTip('browser_evaluate', {
      expression: `document.querySelectorAll('button').length`
    }, 'ok');
    expect(tip).toContain('browser_lookup');
  });

  it('does not return lookup tip when evaluate mutates DOM', () => {
    const tip = getTip('browser_evaluate', {
      expression: `document.querySelector('button').click()`
    }, 'ok');
    // Should get the click tip, not the lookup tip
    expect(tip).not.toContain('browser_lookup');
  });

  // Tip 5: interact select_option on non-<select>
  it('returns select_custom tip on not-a-select error', () => {
    const tip = getTip('browser_interact', {
      actions: [{ type: 'select_option', selector: '.dropdown', value: 'foo' }]
    }, 'error', 'Not a <select> element');
    expect(tip).toContain('select_custom');
  });

  // Tip 6: interact element not found
  it('returns lookup tip on element-not-found error', () => {
    const tip = getTip('browser_interact', {
      actions: [{ type: 'click', selector: 'button.nonexistent' }]
    }, 'error', 'Element not found');
    expect(tip).toContain('browser_lookup');
  });

  // Tip 7: evaluate doing .focus()
  it('returns interact tip when evaluate does .focus()', () => {
    const tip = getTip('browser_evaluate', {
      expression: `document.querySelector('input#email').focus()`
    }, 'ok');
    expect(tip).toContain('browser_interact');
    expect(tip).toContain('focus');
  });

  // Tip 8: evaluate doing window.location
  it('returns navigate tip when evaluate does window.location', () => {
    const tip = getTip('browser_evaluate', {
      expression: `window.location.href = 'https://example.com'`
    }, 'ok');
    expect(tip).toContain('browser_navigate');
  });

  // Tip 9: interact no tab attached
  it('returns attach tip on no-tab error', () => {
    const tip = getTip('browser_interact', {
      actions: [{ type: 'click', selector: 'button' }]
    }, 'error', 'No tab attached');
    expect(tip).toContain('browser_tabs');
    expect(tip).toContain('attach');
  });

  // Tip 10: evaluate doing dispatchEvent
  it('returns interact tip when evaluate does dispatchEvent', () => {
    const tip = getTip('browser_evaluate', {
      expression: `el.dispatchEvent(new MouseEvent('click'))`
    }, 'ok');
    expect(tip).toContain('browser_interact');
    expect(tip).toContain('anti-bot');
  });

  // No tip when nothing matches
  it('returns null when no tip matches', () => {
    const tip = getTip('browser_tabs', { action: 'list' }, 'ok');
    expect(tip).toBeNull();
  });

  // Only one tip per call (highest priority wins)
  it('returns highest priority tip when multiple match', () => {
    // Code that does both .click() and querySelector — click tip wins
    const tip = getTip('browser_evaluate', {
      expression: `const btns = document.querySelectorAll('button'); btns[0].click();`
    }, 'ok');
    expect(tip).toContain('browser_interact');
    // Should be the click tip, not the DOM-read tip
    expect(tip).not.toContain('browser_lookup');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/tips.test.ts`
Expected: FAIL — module `../src/tips` not found

- [ ] **Step 3: Implement the tip registry**

```typescript
// server/src/tips.ts
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
  /** Lower number = higher priority. Checked in order, first match wins. */
  priority: number;
  /** Which tool triggers this tip */
  tool: string;
  /** Evaluate whether this tip should fire */
  match: (params: Record<string, unknown>, result: string, error?: string) => boolean;
  /** The tip text to append */
  message: string;
}

/** Extract the JS code from evaluate params (supports expression, script, function keys) */
function getEvalCode(params: Record<string, unknown>): string {
  return String(params.expression ?? params.script ?? params.function ?? '');
}

/** Check if code contains DOM mutation patterns */
function hasMutation(code: string): boolean {
  const c = code.toLowerCase();
  return c.includes('.click()') || (c.includes('.value') && /\.value\s*=/.test(code)) ||
    c.includes('scrollinto') || c.includes('scrollby') || c.includes('scrollto') ||
    c.includes('.focus()') || c.includes('.select()') || c.includes('dispatchevent') ||
    c.includes('window.location') || c.includes('document.location');
}

const TIPS: TipRule[] = [
  // ── evaluate tips (by priority — mutation tips before read tips) ──

  {
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

  // ── interact error tips ──

  {
    priority: 5,
    tool: 'browser_interact',
    match: (_params, _result, error) => !!error && /no tab attached/i.test(error),
    message:
      'Tip: No tab is attached. Use browser_tabs action=\'attach\' to attach to a tab before interacting.',
  },
  {
    priority: 10,
    tool: 'browser_interact',
    match: (_params, _result, error) => !!error && /not a <select>/i.test(error),
    message:
      'Tip: This element is a JS-driven dropdown, not a native <select>. Use action: \'select_custom\' instead of \'select_option\'.',
  },
  {
    priority: 15,
    tool: 'browser_interact',
    match: (_params, _result, error) => !!error && /element not found/i.test(error),
    message:
      'Tip: Element not found by CSS selector. Use browser_lookup to find elements by visible text — it returns ' +
      'selectors you can pass to browser_interact. You can also use :has-text("...") in selectors, e.g. button:has-text("Next").',
  },
];

/**
 * Evaluate all tip rules against a completed tool call and return
 * the highest-priority matching tip, or null if none match.
 */
export function getTip(
  tool: string,
  params: Record<string, unknown>,
  result: 'ok' | 'error',
  error?: string
): string | null {
  let best: TipRule | null = null;

  for (const rule of TIPS) {
    if (rule.tool !== tool) continue;
    if (best && rule.priority >= best.priority) continue;
    if (rule.match(params, result, error)) {
      best = rule;
    }
  }

  return best?.message ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/tips.test.ts`
Expected: All 13 tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/tips.ts server/tests/tips.test.ts
git commit -m "feat: add targeted tool tip registry with 10 contextual tips"
```

---

### Task 2: Wire tips into BrowserBridge.callTool()

**Files:**
- Modify: `server/src/tools.ts` (import getTip, call it in callTool, append to response)
- Test: `server/tests/tools.test.ts` (add tip integration tests)

- [ ] **Step 1: Write failing tests for tip integration**

Add to the end of `server/tests/tools.test.ts`:

```typescript
describe('tool tips integration', () => {
  it('appends tip when evaluate does a JS click', async () => {
    const ext = createMockExt();
    ext.sendCmd.mockResolvedValue('clicked');
    const bridge = new BrowserBridge({}, ext);
    await bridge.initialize({}, {}, createMockConnectionManager());

    const result = await bridge.callTool('browser_evaluate', {
      expression: `document.querySelector('button').click()`,
    });

    const text = result.content[0].text;
    expect(text).toContain('Tip:');
    expect(text).toContain('browser_interact');
  });

  it('does not append tip when evaluate does safe read', async () => {
    const ext = createMockExt();
    ext.sendCmd.mockResolvedValue('42');
    const bridge = new BrowserBridge({}, ext);
    await bridge.initialize({}, {}, createMockConnectionManager());

    const result = await bridge.callTool('browser_evaluate', {
      expression: `document.title`,
    });

    const text = result.content[0].text;
    expect(text).not.toContain('Tip:');
  });

  it('appends tip on interact element-not-found error', async () => {
    const ext = createMockExt();
    ext.sendCmd.mockRejectedValue(new Error('Element not found: `button.missing`'));
    const bridge = new BrowserBridge({}, ext);
    await bridge.initialize({}, {}, createMockConnectionManager());

    const result = await bridge.callTool('browser_interact', {
      actions: [{ type: 'click', selector: 'button.missing' }],
    });

    const text = result.content[0].text;
    expect(text).toContain('Tip:');
    expect(text).toContain('browser_lookup');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/tools.test.ts`
Expected: FAIL — no tip appended to results yet

- [ ] **Step 3: Wire getTip into callTool**

In `server/src/tools.ts`, add the import at the top with the other imports:

```typescript
import { getTip } from './tips';
```

Then modify the `callTool` method. Replace the `finally` block (around line 387-398):

```typescript
    } finally {
      const url = this._getCurrentUrl();

      // Compute tip once — used in both response and audit log
      const tip = !options.rawResult ? getTip(name, args, callResult, callError) : null;

      this.auditLogger?.write({
        session_id: this.connectionManager?.clientId ?? 'unknown',
        tool: name,
        params: args,
        result: callResult,
        error: callError,
        url,
        duration_ms: Date.now() - start,
        ...(tip ? { tip } : {}),
      });

      // Append contextual tip to response
      if (tip && result?.content?.[0]?.type === 'text') {
        result.content[0].text += `\n\n---\n${tip}`;
      }
    }
```

- [ ] **Step 4: Run all tools tests to verify they pass**

Run: `cd server && npx vitest run tests/tools.test.ts`
Expected: All existing tests PASS plus the 3 new tip integration tests

- [ ] **Step 5: Commit**

```bash
git add server/src/tools.ts server/tests/tools.test.ts
git commit -m "feat: wire tool tips into BrowserBridge callTool responses"
```

---

### Task 3: Update selector description in interact schema

**Files:**
- Modify: `server/src/tools/schemas.ts:94`

This is the one-liner fix that complements the tip system — agents see this in the tool definition before they ever make a call.

- [ ] **Step 1: Update the selector description**

In `server/src/tools/schemas.ts` line 94, change:

```typescript
selector: { type: 'string', description: 'CSS selector for the target element. For wait: element to poll for existence.' },
```

to:

```typescript
selector: { type: 'string', description: 'CSS selector for the target element. Supports :has-text("...") for text matching, e.g. button:has-text("Submit"). For wait: element to poll for existence.' },
```

- [ ] **Step 2: Verify build succeeds**

Run: `npm run build.server`
Expected: Build completes with no errors

- [ ] **Step 3: Commit**

```bash
git add server/src/tools/schemas.ts
git commit -m "feat: document :has-text() pseudo-selector in interact schema description"
```

---

### Task 4: Add tip field to audit log entries

**Files:**
- Modify: `server/src/audit-logger.ts` (add `tip` field to AuditEntry)
- Test: `server/tests/audit-logger.test.ts` (verify tip field written)

This lets future audits answer "was the agent shown a tip, and did they follow it next call?"

- [ ] **Step 1: Write failing test for tip in audit entry**

Add to `server/tests/audit-logger.test.ts`:

```typescript
it('includes tip field when provided', () => {
  logger.write({
    session_id: 'test',
    tool: 'browser_evaluate',
    params: { expression: 'document.querySelector("button").click()' },
    result: 'ok',
    duration_ms: 50,
    tip: 'Tip: use browser_interact instead',
  });

  const lines = fs.readFileSync(logger.getPath(), 'utf8').trim().split('\n');
  const entry = JSON.parse(lines[lines.length - 1]);
  expect(entry.tip).toBe('Tip: use browser_interact instead');
});

it('omits tip field when null', () => {
  logger.write({
    session_id: 'test',
    tool: 'browser_tabs',
    params: { action: 'list' },
    result: 'ok',
    duration_ms: 10,
  });

  const lines = fs.readFileSync(logger.getPath(), 'utf8').trim().split('\n');
  const entry = JSON.parse(lines[lines.length - 1]);
  expect(entry.tip).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/audit-logger.test.ts`
Expected: FAIL — `tip` field not in AuditEntry type

- [ ] **Step 3: Add tip field to AuditEntry**

In `server/src/audit-logger.ts`, update the interface:

```typescript
export interface AuditEntry {
  ts: string;
  version: string;
  session_id: string;
  tool: string;
  params: Record<string, unknown>;
  result: 'ok' | 'error';
  error?: string;
  url?: string;
  duration_ms: number;
  tip?: string;
}
```

No other changes needed — the spread in `write()` already includes all fields from the entry, and `JSON.stringify` naturally omits `undefined` values.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/audit-logger.test.ts`
Expected: All tests PASS (existing 14 + 2 new)

- [ ] **Step 5: Commit**

```bash
git add server/src/audit-logger.ts server/tests/audit-logger.test.ts
git commit -m "feat: log which tip was shown in audit entries for follow-through analysis"
```

---

### Task 5: Update audit skill to analyze tip effectiveness

**Files:**
- Modify: `.claude/skills/usage-data-audit/SKILL.md`

- [ ] **Step 1: Add tip analysis section to the skill**

Add the following after the "Version Correlation" section in `SKILL.md`:

```markdown
### Tip Effectiveness

Entries from v1.5.1+ may include a `tip` field — the contextual hint shown to the agent after that tool call. When tip data is present, analyze:

- **Tip frequency:** How often each tip fires, by tool and session.
- **Follow-through rate:** After a tip fires, did the agent use the suggested tool on their next call? For example, if tip says "use browser_interact", did the next call use browser_interact?
- **Repeat offenders:** Agents that receive the same tip 3+ times in a session are ignoring it. Flag these patterns — the tip text may need revision, or the tool gap may be deeper than a hint can fix.

Include a Tip Effectiveness section in every report where tip data exists. Format:

| Tip | Times Shown | Followed | Ignored | Follow % |
|-----|-------------|----------|---------|----------|
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/usage-data-audit/SKILL.md
git commit -m "feat: add tip effectiveness analysis to audit skill"
```

---

### Task 6: Build and verify

**Files:**
- No new files — verification only

- [ ] **Step 1: Run full server test suite**

Run: `cd server && npx vitest run`
Expected: All tests pass (excluding pre-existing daemon-client socket permission failures in sandbox)

- [ ] **Step 2: Build server**

Run: `npm run build.server`
Expected: Build completes with no errors

- [ ] **Step 3: Verify tip works end-to-end manually (optional)**

Start dev server, connect to browser, run:
```
browser_evaluate expression: "document.querySelector('button').click()"
```
Expected: Response includes the `:has-text()` tip at the bottom

- [ ] **Step 4: Commit any build artifacts if needed**

```bash
git add -A && git status
# Only commit if dist files changed
git commit -m "chore: rebuild server dist"
```
