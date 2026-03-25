# Audit Fixes Round 1: Evaluate Wrapper, Tab State, Fill Form

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three bugs/limitations identified by audit log analysis of the `job-search-operator` session (4,444 calls, 352 errors): evaluate wrapper SyntaxError on statements, tab "no tab attached" state loss, and fill_form failure on React-controlled inputs.

**Architecture:** Three independent fixes across server and extension. Fix 3 modifies `wrapWithPageProxy()` to detect statement vs expression code. Fix 4 adds auto-reattach logic in `handleTabClosed()`. Fix 5 adds blur/focus events and a microtask yield to `onFillForm()` for React reconciliation.

**Tech Stack:** TypeScript, Vitest, acorn (already a dependency)

---

### Task 1: Fix evaluate wrapper SyntaxError on statement code

**Context:** `wrapWithPageProxy()` in `server/src/experimental/secure-eval.ts` wraps user code as `return (${code});`. This works for expressions like `document.title` but produces `SyntaxError: Unexpected token 'const'` for statement code like `const x = 1; return x`. The audit log shows 48 occurrences of this error pattern in a single session.

**Root cause:** The wrapper assumes all user code is a single expression. When code contains `const`, `var`, `let`, or other statements, parsing `return (const x = 1)` is a syntax error.

**Fix:** Detect whether code is an expression or statement block using acorn's expression parser. If it parses as an expression, use the current `return (${code})` wrapper. If not, wrap in a nested arrow IIFE: `return (() => { ${code} })()` which allows statements and captures the return value.

**Files:**
- Modify: `server/src/experimental/secure-eval.ts:469-534`
- Test: `server/tests/secure-eval.test.ts`

- [ ] **Step 1: Write failing tests for statement code in wrapWithPageProxy**

Add these tests after the existing `wrapWithPageProxy` describe block (after line 760 in `server/tests/secure-eval.test.ts`):

```typescript
  it('wraps expression code with direct return', () => {
    const wrapped = wrapWithPageProxy('document.title');
    // Expression path: return (code);
    expect(wrapped).toContain('return (\ndocument.title\n);');
  });

  it('wraps statement code with nested IIFE', () => {
    const wrapped = wrapWithPageProxy('const x = 1; return x;');
    // Statement path: return (() => { code })();
    expect(wrapped).toContain('return (() => { const x = 1; return x; })();');
  });

  it('wraps var declarations with nested IIFE', () => {
    const wrapped = wrapWithPageProxy('var items = document.querySelectorAll("a"); return items.length;');
    expect(wrapped).toContain('return (() => {');
    expect(wrapped).toContain('})();');
  });

  it('wraps multiline statement code with nested IIFE', () => {
    const code = `const el = document.querySelector('.btn');\nel.click();\nreturn true;`;
    const wrapped = wrapWithPageProxy(code);
    expect(wrapped).toContain('return (() => {');
    expect(wrapped).toContain(code);
  });

  it('keeps single expression without nested IIFE', () => {
    const wrapped = wrapWithPageProxy("document.querySelector('h1').textContent");
    // Should NOT use the IIFE path
    expect(wrapped).not.toContain('(() => {');
  });

  it('treats IIFE expressions as expressions', () => {
    const code = "(() => { const x = 1; return x; })()";
    const wrapped = wrapWithPageProxy(code);
    // Already an expression — should use direct return
    expect(wrapped).toContain('return (\n');
    expect(wrapped).not.toContain('return (() => {');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jahcrispy646/Projects/Github/supersurf && npm run test.server -- --run --reporter=verbose -t "wrapWithPageProxy"`

Expected: The "wraps statement code with nested IIFE" and "wraps var declarations with nested IIFE" and "wraps multiline statement code" tests should fail (they'll get `return (\nconst x...` instead of the IIFE wrapper).

- [ ] **Step 3: Add isExpression helper and update wrapWithPageProxy**

In `server/src/experimental/secure-eval.ts`, add the helper function before `wrapWithPageProxy` (before line 469), and update the wrapper:

```typescript
/**
 * Detect whether code is a single JS expression (vs statement block).
 * Uses acorn's expression parser — if it successfully parses the entire
 * string as an expression, it's expression code. Otherwise, statement code.
 */
function isExpression(code: string): boolean {
  try {
    const trimmed = code.trim();
    if (!trimmed) return true;
    const ast = acorn.parseExpressionAt(trimmed, 0, {
      ecmaVersion: 'latest',
    }) as any;
    // Ensure the expression consumed all the input (no trailing statements)
    return ast.end >= trimmed.length;
  } catch {
    return false;
  }
}
```

Then in `wrapWithPageProxy`, replace lines 526-531:

```typescript
  with(__proxy) {
    return (function() { "use strict";
return (
${code}
);
    })();
  }
```

With:

```typescript
  with(__proxy) {
    return (function() { "use strict";
${isExpression(code) ? `return (\n${code}\n);` : `return (() => { ${code} })();`}
    })();
  }
```

The full updated function becomes:

```typescript
export function wrapWithPageProxy(code: string): string {
  const blockedJSON = JSON.stringify(PAGE_BLOCKED);
  const subRulesJSON = JSON.stringify(SUB_OBJECT_RULES);
  const inner = isExpression(code) ? `return (\n${code}\n);` : `return (() => { ${code} })();`;
  return `(function() {
  var __blocked = new Set(${blockedJSON});
  var __globalAliases = new Set(['window', 'globalThis', 'self', 'top', 'frames', 'parent']);
  var __subRules = ${subRulesJSON};
  function __wrapSub(obj, name) {
    var rules = __subRules[name];
    if (!rules) return obj;
    var blockedSet = new Set(rules.blocked);
    var aliases = rules.aliases;
    return new Proxy(obj, {
      get: function(t, p) {
        if (typeof p === 'string' && blockedSet.has(p)) {
          throw new Error('[secure_eval] Blocked: ' + name + '.' + p);
        }
        if (typeof p === 'string' && aliases[p] === '__proxy') {
          return __proxy;
        }
        var v = Reflect.get(t, p);
        if (typeof v === 'function') return v.bind(t);
        return v;
      }
    });
  }
  var __proxy = new Proxy(window, {
    get: function(t, p) {
      if (typeof p === 'string' && __blocked.has(p)) {
        throw new Error('[secure_eval] Blocked: ' + p);
      }
      if (typeof p === 'string' && __globalAliases.has(p)) {
        return __proxy;
      }
      var v = Reflect.get(t, p);
      if (v === window) return __proxy;
      if (typeof p === 'string' && __subRules[p] && typeof v === 'object' && v !== null) {
        return __wrapSub(v, p);
      }
      return v;
    },
    has: function() { return true; },
    getOwnPropertyDescriptor: function(t, p) {
      if (typeof p === 'string' && __blocked.has(p)) {
        return { configurable: true, enumerable: false, get: function() {
          throw new Error('[secure_eval] Blocked: ' + p);
        }};
      }
      if (typeof p === 'string' && __globalAliases.has(p)) {
        return { configurable: true, enumerable: true, value: __proxy };
      }
      return Object.getOwnPropertyDescriptor(t, p);
    },
    ownKeys: function(t) {
      return Reflect.ownKeys(t);
    }
  });
  with(__proxy) {
    return (function() { "use strict";
${inner}
    })();
  }
})()`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/jahcrispy646/Projects/Github/supersurf && npm run test.server -- --run --reporter=verbose -t "wrapWithPageProxy"`

Expected: All wrapWithPageProxy tests pass, including the new ones.

- [ ] **Step 5: Run full server test suite to check for regressions**

Run: `cd /Users/jahcrispy646/Projects/Github/supersurf && npm run test.server -- --run`

Expected: All server tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/jahcrispy646/Projects/Github/supersurf
git add server/src/experimental/secure-eval.ts server/tests/secure-eval.test.ts
git commit -m "fix: evaluate wrapper handles statement code via nested IIFE

wrapWithPageProxy() used return(code) which failed on const/var/let
statements. Now detects expression vs statement code using acorn and
wraps statements in an arrow IIFE. Fixes 48 SyntaxErrors per session."
```

---

### Task 2: Harden tab "no tab attached" state

**Context:** The extension's `handleTabClosed()` sets `attachedTabId = null` when the attached tab closes, but nothing auto-reattaches to another available tab. This leaves the session in a detached state where subsequent operations (closeTab without index, and other tab-implicit commands) throw "No tab specified and no tab attached". The audit shows 24 occurrences of this error.

**Additionally:** The `closeTab()` method throws this error when called without an index and no tab is attached. A better behavior is to surface which tabs are available rather than a cryptic error.

**Fix:** Two changes:
1. In `handleTabClosed()`, auto-reattach to the most recently active tab in the same session group (or any normal-window tab if no groups).
2. Improve the error message in `closeTab()` to include available tab count.

**Files:**
- Modify: `extension/src/handlers/tabs.ts:351-401`
- Test: `extension/tests/handlers/tabs.test.ts`

- [ ] **Step 1: Write failing tests for auto-reattach and improved error**

Add these tests inside the `closeTab()` describe block in `extension/tests/handlers/tabs.test.ts` (after the existing "clears attached tab if the closed tab was attached" test):

```typescript
    it('auto-reattaches to another tab when attached tab is closed externally', async () => {
      // Create and select a tab
      const tab1 = { id: 50, index: 0, title: 'Tab 1', url: 'https://a.com', windowId: 1 };
      const tab2 = { id: 60, index: 1, title: 'Tab 2', url: 'https://b.com', windowId: 1 };
      mockChrome.tabs.create.mockResolvedValue(tab1);
      await tabs.createTab({ url: 'https://a.com' });
      mockChrome.tabs.create.mockResolvedValue(tab2);
      await tabs.createTab({ url: 'https://b.com' });

      // Attach to tab1
      mockChrome.tabs.query.mockResolvedValue([tab1, tab2]);
      await tabs.selectTab({ index: 0 });
      expect(tabs.getAttachedTabId()).toBe(50);

      // Simulate tab1 closing externally — query returns remaining tabs
      mockChrome.tabs.query.mockResolvedValue([tab2]);
      // Mock windows.get for the auto-reattach
      (mockChrome as any).windows = { get: vi.fn().mockResolvedValue({ type: 'normal' }) };

      tabs.handleTabClosed(50);

      // Wait for async auto-reattach
      await new Promise(r => setTimeout(r, 10));

      expect(tabs.getAttachedTabId()).toBe(60);
    });

    it('sets attachedTabId to null when no other tabs available after close', async () => {
      const tab1 = { id: 50, index: 0, title: 'Tab 1', url: 'https://a.com', windowId: 1 };
      mockChrome.tabs.create.mockResolvedValue(tab1);
      await tabs.createTab({ url: 'https://a.com' });

      // No other tabs available
      mockChrome.tabs.query.mockResolvedValue([]);

      tabs.handleTabClosed(50);
      await new Promise(r => setTimeout(r, 10));

      expect(tabs.getAttachedTabId()).toBeNull();
    });

    it('throws descriptive error when closing with no tab and none attached', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 10, title: 'Tab 0', url: 'https://a.com' },
        { id: 20, title: 'Tab 1', url: 'https://b.com' },
      ]);

      await expect(tabs.closeTab()).rejects.toThrow(/No tab specified and no tab attached/);
      await expect(tabs.closeTab()).rejects.toThrow(/2 tabs? available/);
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jahcrispy646/Projects/Github/supersurf && npm run test.extension -- --run --reporter=verbose -t "closeTab"`

Expected: The new tests fail — `handleTabClosed` doesn't auto-reattach, and the error message doesn't mention available tabs.

- [ ] **Step 3: Update handleTabClosed to auto-reattach**

In `extension/src/handlers/tabs.ts`, replace the `handleTabClosed` method (lines 392-399):

```typescript
  /** Clean up attachment state, stealth tracking, and tech stack info for a closed tab. */
  handleTabClosed(tabId: number): void {
    const wasAttached = tabId === this.ctx.attachedTabId;

    if (wasAttached) {
      this.ctx.attachedTabId = null;
      this.iconManager.setAttachedTab(null);
    }
    this.ctx.stealthTabs.delete(tabId);
    this.ctx.persistSession();
    this.techStackInfo.delete(tabId);

    // Auto-reattach to another tab if the attached tab was closed
    if (wasAttached) {
      this.autoReattach().catch(() => {});
    }
  }

  /**
   * Attempt to reattach to the most recent normal-window tab after the
   * attached tab is closed. Silently does nothing if no candidates exist.
   */
  private async autoReattach(): Promise<void> {
    try {
      const allTabs = await this.browser.tabs.query({ windowType: 'normal' });
      // Filter to automatable tabs (not chrome://, not chrome-extension://)
      const candidates = allTabs.filter(t =>
        t.id && t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://')
      );

      if (candidates.length === 0) return;

      // Prefer the currently active tab, otherwise take the last one
      const active = candidates.find(t => t.active);
      const target = active || candidates[candidates.length - 1];

      this.ctx.attachedTabId = target.id!;
      this.ctx.persistSession();
      this.iconManager.setAttachedTab(target.id!);
      this.logger.log(`Auto-reattached to tab ${target.id} (${target.url})`);
    } catch {
      // Best-effort — don't break the close flow
    }
  }
```

- [ ] **Step 4: Improve the closeTab error message**

In the same file, update the `closeTab` method's else branch (line 382). Replace:

```typescript
      throw new Error('No tab specified and no tab attached');
```

With:

```typescript
      const available = await this.browser.tabs.query({ windowType: 'normal' });
      const count = available.length;
      throw new Error(`No tab specified and no tab attached. ${count} tab${count !== 1 ? 's' : ''} available — use selectTab first or pass an index.`);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/jahcrispy646/Projects/Github/supersurf && npm run test.extension -- --run --reporter=verbose -t "closeTab"`

Expected: All closeTab tests pass including the new ones.

- [ ] **Step 6: Update the existing test assertion for the error message**

The existing test at line 282 expects `'No tab specified and no tab attached'`. Update it to match the new message:

```typescript
    it('throws when no tab specified and none attached', async () => {
      mockChrome.tabs.query.mockResolvedValue([]);
      await expect(tabs.closeTab()).rejects.toThrow('No tab specified and no tab attached');
    });
```

This should still pass since the new message starts with the same string. Verify by running the test.

- [ ] **Step 7: Run full extension test suite**

Run: `cd /Users/jahcrispy646/Projects/Github/supersurf && npm run test.extension -- --run`

Expected: All extension tests pass.

- [ ] **Step 8: Commit**

```bash
cd /Users/jahcrispy646/Projects/Github/supersurf
git add extension/src/handlers/tabs.ts extension/tests/handlers/tabs.test.ts
git commit -m "fix: auto-reattach to available tab when attached tab closes

handleTabClosed() now attempts to reattach to the most recent
normal-window tab instead of leaving the session detached. Also
improves the closeTab error message to show available tab count.
Addresses 24 'no tab attached' errors per long-running session."
```

---

### Task 3: Improve fill_form for React-controlled inputs

**Context:** `onFillForm()` in `server/src/tools/forms.ts` uses native prototype setters and dispatches `input`/`change` events, but has a 21.7% error rate on modern ATS platforms. Three gaps:
1. No `focus`/`blur` events — many forms validate or update state on blur
2. No microtask yield — React reconciliation can overwrite the value before `change` fires
3. No `InputEvent` — React 17+ uses `InputEvent` not `Event` for synthetic event detection

**Fix:** Add `focus` before setting value, use `InputEvent` for the input event, add a microtask yield (`await Promise.resolve()`) before dispatching `change`, and dispatch `blur` after. This matches the event sequence a real user produces: focus → input → (React reconciles) → change → blur.

**Files:**
- Modify: `server/src/tools/forms.ts:27-78`
- Test: `server/tests/tools-forms.test.ts`

- [ ] **Step 1: Write failing tests for focus/blur/InputEvent dispatch**

Add these tests inside the `onFillForm()` describe block in `server/tests/tools-forms.test.ts` (after the existing "returns raw result" test):

```typescript
  it('dispatches focus, InputEvent, change, and blur events', async () => {
    let evalCode = '';
    (ctx.eval as any).mockImplementation((code: string) => {
      evalCode = code;
      return Promise.resolve(undefined);
    });

    await onFillForm(ctx, {
      fields: [{ selector: '#name', value: 'John' }],
    }, {});

    // Should dispatch focus before setting value
    expect(evalCode).toContain("dispatchEvent(new Event('focus'");
    // Should use InputEvent for input event (React 17+ compatibility)
    expect(evalCode).toContain("new InputEvent('input'");
    // Should dispatch blur after change
    expect(evalCode).toContain("dispatchEvent(new Event('blur'");
    // Should have microtask yield before change
    expect(evalCode).toContain('Promise.resolve()');
  });

  it('uses native prototype setter for input elements', async () => {
    let evalCode = '';
    (ctx.eval as any).mockImplementation((code: string) => {
      evalCode = code;
      return Promise.resolve(undefined);
    });

    await onFillForm(ctx, {
      fields: [{ selector: '#email', value: 'test@test.com' }],
    }, {});

    // Should still use the native setter pattern
    expect(evalCode).toContain('Object.getOwnPropertyDescriptor(HTMLInputElement.prototype');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jahcrispy646/Projects/Github/supersurf && npm run test.server -- --run --reporter=verbose -t "onFillForm"`

Expected: The new tests fail — current code uses `Event('input')` not `InputEvent`, and doesn't dispatch focus/blur.

- [ ] **Step 3: Update onFillForm with improved event sequence**

Replace the `onFillForm` function in `server/src/tools/forms.ts` (lines 27-78):

```typescript
export async function onFillForm(ctx: ToolContext, args: any, options: any): Promise<any> {
  const fields = args.fields as any[];
  const results: string[] = [];

  for (const field of fields) {
    const expr = ctx.getSelectorExpression(field.selector);
    await ctx.eval(`
      (async () => {
        const el = ${expr};
        if (!el) throw new Error('Element not found: ${field.selector}');
        const tag = el.tagName;
        const type = el.type;

        // Focus the element first (triggers onFocus handlers)
        el.dispatchEvent(new Event('focus', { bubbles: true }));
        el.focus();

        if (type === 'checkbox' || type === 'radio') {
          el.checked = ${JSON.stringify(field.value)} === 'true' || ${JSON.stringify(field.value)} === true;
        } else if (tag === 'SELECT') {
          const options = Array.from(el.options);
          const target = ${JSON.stringify(field.value)};
          if (el.multiple) {
            const targets = target.split(',').map(t => t.trim());
            for (const opt of options) {
              opt.selected = targets.includes(opt.value) || targets.includes(opt.textContent?.trim());
            }
          } else {
            let opt = options.find(o => o.value === target);
            if (!opt) opt = options.find(o => o.textContent?.trim().toLowerCase() === target.toLowerCase());
            if (!opt) throw new Error('Option not found: ' + target);
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
            if (setter) setter.call(el, opt.value);
            else el.value = opt.value;
          }
        } else if (tag === 'TEXTAREA') {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          if (setter) setter.call(el, ${JSON.stringify(field.value)});
          else el.value = ${JSON.stringify(field.value)};
        } else {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, ${JSON.stringify(field.value)});
          else el.value = ${JSON.stringify(field.value)};
        }

        // InputEvent for React 17+ synthetic event detection
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
        // Microtask yield — let React reconcile before change fires
        await Promise.resolve();
        el.dispatchEvent(new Event('change', { bubbles: true }));
        // Blur triggers onBlur validation handlers
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      })()
    `);
    results.push(`✓ ${field.selector} = "${field.value}"`);
  }

  if (options.rawResult) return { success: true, fields: results };
  return { content: [{ type: 'text', text: results.join('\n') }] };
}
```

Key changes from the original:
- Wrapped in `async` IIFE to allow `await`
- Added `focus` event + `el.focus()` before setting value
- Changed `new Event('input')` to `new InputEvent('input', { inputType: 'insertText' })` for React 17+
- Added `await Promise.resolve()` microtask yield before `change` event
- Added `blur` event after `change`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/jahcrispy646/Projects/Github/supersurf && npm run test.server -- --run --reporter=verbose -t "onFillForm"`

Expected: All onFillForm tests pass including the new ones.

- [ ] **Step 5: Run full server test suite**

Run: `cd /Users/jahcrispy646/Projects/Github/supersurf && npm run test.server -- --run`

Expected: All server tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/jahcrispy646/Projects/Github/supersurf
git add server/src/tools/forms.ts server/tests/tools-forms.test.ts
git commit -m "fix: fill_form dispatches focus/blur and uses InputEvent for React compat

Adds focus event before value set, uses InputEvent (not Event) for the
input event so React 17+ synthetic event system picks it up, yields a
microtask for React reconciliation, and dispatches blur for onBlur
validation. Addresses 21.7% fill_form error rate on modern ATS forms."
```

---

### Task 4: Build and verify

- [ ] **Step 1: Build all packages**

Run: `cd /Users/jahcrispy646/Projects/Github/supersurf && npm run build`

Expected: Clean build with no errors.

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/jahcrispy646/Projects/Github/supersurf && npm run test`

Expected: All tests pass across daemon, server, and extension.

- [ ] **Step 3: Verify no regressions in existing wrapWithPageProxy behavior**

Run: `cd /Users/jahcrispy646/Projects/Github/supersurf && npm run test.server -- --run --reporter=verbose -t "secure_eval"`

Expected: All secure_eval tests pass (existing + new).
