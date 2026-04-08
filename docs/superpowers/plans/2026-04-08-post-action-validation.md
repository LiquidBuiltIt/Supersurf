# Post-Action Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `fill_form`, `select_custom`, and `file_upload` verify their mutations actually took effect, instead of returning `success: true` blindly. Catch silent failures at the tool layer instead of at form-submission time.

**Architecture:** Each tool performs its mutation as today, then immediately reads back the relevant DOM/CDP state and compares to the expected post-state. The success message is prefixed with `✓` (verified) or `⚠` (mutation ran but read-back didn't confirm). No new types, no shared verification module — each tool's read-back is small and inline. Task 1 is a research task that diagnoses the long-standing fill_form silent-failure on React controlled inputs; its findings inform fill_form's read-back strategy in Task 4.

**Tech Stack:** TypeScript, Vitest, CDP (Runtime.evaluate, DOM.setFileInputFiles), inline JS templates evaluated in page context.

---

## File Structure

- **Modify:** `server/src/tools/forms.ts` — `onFillForm` adds DOM value read-back
- **Modify:** `server/src/tools/interaction.ts` — `select_custom` adds trigger-text read-back; `file_upload` adds `el.files.length` read-back
- **Modify:** `server/tests/tools-forms.test.ts` — read-back tests
- **Modify:** `server/tests/tools-interaction.test.ts` — read-back tests
- **Create:** `docs/research/2026-04-08-fill-form-react-state-investigation.md` — Task 1 output, frozen artifact, not edited later

No new modules or shared helpers. Each tool's verification is ~10 lines of inline JS in its existing eval template. The cost of an abstraction here is higher than the savings.

---

## Task 1: Investigate `fill_form` React state mutation root cause

**Research only — no production code, no tests. Output is a markdown document that informs Task 4's read-back strategy.**

**Files:**
- Create: `docs/research/2026-04-08-fill-form-react-state-investigation.md`
- Read (no edit): `server/src/tools/forms.ts:27-86`

- [ ] **Step 1: Read the current `onFillForm` implementation end-to-end**

Read `server/src/tools/forms.ts:27-86`. Note the exact event sequence:
1. `el.dispatchEvent(new Event('focus', ...))` + `el.focus()`
2. Native descriptor setter call (`HTMLInputElement.prototype` value setter)
3. `el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))`
4. `await Promise.resolve()` (microtask yield)
5. `el.dispatchEvent(new Event('change', { bubbles: true }))`
6. `el.dispatchEvent(new Event('blur', { bubbles: true }))`

- [ ] **Step 2: Cross-reference with React's value tracker behavior**

Re-read the web-search agent's findings (already in conversation history) about facebook/react#10135 and the value-tracker mechanism. Confirm the canonical sequence community sources use:
1. Native setter call (bypasses React's monkey-patched setter, leaves tracker stale)
2. `dispatchEvent(new Event('input', { bubbles: true }))` — React diffs DOM vs tracker, sees mismatch, fires synthetic onChange

Note any deviations between SuperSurf's sequence and the canonical pattern.

- [ ] **Step 3: Form a single hypothesis with evidence**

Pick the most likely cause from these candidates:
- (a) `InputEvent` (vs plain `Event`) — React expects `Event` for the `input` synthetic
- (b) Microtask yield between input and change — React commits before change fires
- (c) `focus` event dispatched BEFORE the value mutation, instead of after the value is set
- (d) Something else discovered during reading

For the chosen hypothesis, write down:
- What change would test it
- What read-back would prove the fix worked
- Whether the failure is silent (DOM updated but React state stale) or loud (DOM not updated at all)

- [ ] **Step 4: Write the investigation document**

Create `docs/research/2026-04-08-fill-form-react-state-investigation.md` with these sections:
- **Current event sequence** (numbered list)
- **Canonical React community sequence** (numbered list, cite facebook/react#10135)
- **Diff** (what differs)
- **Hypothesis** (one paragraph, name the most likely cause)
- **Implications for read-back strategy** (one paragraph, used by Task 4)
- **Out of scope** (what this investigation does NOT prove — e.g., does not prove a fix works on real React, would need a live page test)

Do not modify forms.ts in this task. If the hypothesis suggests a code change, that's a follow-up plan. This task only documents.

- [ ] **Step 5: Commit**

```bash
git add docs/research/2026-04-08-fill-form-react-state-investigation.md
git commit -m "research: diagnose fill_form React state mutation failure mode"
```

---

## Task 2: Add `file_upload` post-action validation

`file_upload` is the simplest case — read back `el.files.length` after `DOM.setFileInputFiles`. No React, no events. Start here to lock in the success/warning message format.

**Files:**
- Modify: `server/src/tools/interaction.ts:585-598` (the `file_upload` case)
- Test: `server/tests/tools-interaction.test.ts`

- [ ] **Step 1: Write the failing test for verified upload**

Add to `server/tests/tools-interaction.test.ts` inside the existing `describe('onInteract()', ...)` block, near the other interaction tests:

```typescript
describe('file_upload post-action validation', () => {
  it('returns ✓ when files are present after upload', async () => {
    // Mock CDP: querySelector returns objectId, describeNode returns backendNodeId,
    // setFileInputFiles succeeds, then read-back eval returns the expected count
    (ctx.cdp as any).mockImplementation((method: string) => {
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { objectId: 'obj-1' } });
      if (method === 'DOM.describeNode') return Promise.resolve({ node: { backendNodeId: 99 } });
      if (method === 'DOM.setFileInputFiles') return Promise.resolve({});
      return Promise.resolve({});
    });
    (ctx.eval as any).mockResolvedValue({ verified: true, count: 2 });

    const result = await onInteract(ctx, {
      actions: [{ type: 'file_upload', selector: 'input[type=file]', files: ['/tmp/a.pdf', '/tmp/b.pdf'] }],
    }, {});

    expect(result.content[0].text).toContain('✓ file_upload');
    expect(result.content[0].text).toContain('Uploaded 2 file(s)');
  });

  it('returns ⚠ when files.length is 0 after upload', async () => {
    (ctx.cdp as any).mockImplementation((method: string) => {
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { objectId: 'obj-1' } });
      if (method === 'DOM.describeNode') return Promise.resolve({ node: { backendNodeId: 99 } });
      if (method === 'DOM.setFileInputFiles') return Promise.resolve({});
      return Promise.resolve({});
    });
    (ctx.eval as any).mockResolvedValue({ verified: false, count: 0 });

    const result = await onInteract(ctx, {
      actions: [{ type: 'file_upload', selector: 'input[type=file]', files: ['/tmp/a.pdf'] }],
    }, {});

    expect(result.content[0].text).toContain('⚠ file_upload');
    expect(result.content[0].text).toContain('unverified');
  });
});
```

- [ ] **Step 2: Run tests to verify both fail**

```bash
npx vitest run server/tests/tools-interaction.test.ts -t "file_upload post-action validation"
```

Expected: 2 FAIL. The current implementation returns `Uploaded N file(s)` with no `✓`/`⚠` distinction, so both new tests should fail.

- [ ] **Step 3: Add the read-back to `file_upload`**

In `server/src/tools/interaction.ts`, replace the `file_upload` case body:

```typescript
case 'file_upload': {
  const evalResult = await ctx.cdp('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(action.selector)})`,
    returnByValue: false,
  });
  if (!evalResult.result?.objectId) throw new Error(`Element not found: ${action.selector}`);

  const nodeResult = await ctx.cdp('DOM.describeNode', { objectId: evalResult.result.objectId });
  await ctx.cdp('DOM.setFileInputFiles', {
    files: action.files,
    backendNodeId: nodeResult.node.backendNodeId,
  });

  // Post-action read-back: confirm the input now reports the expected file count.
  // setFileInputFiles is a CDP-only operation that doesn't always fire 'change',
  // so the page-level state (and any React listeners) may not see the upload.
  const verification = await ctx.eval(`
    (() => {
      const el = document.querySelector(${JSON.stringify(action.selector)});
      if (!el) return { verified: false, count: 0 };
      const count = el.files ? el.files.length : 0;
      return { verified: count === ${action.files.length}, count };
    })()
  `);

  const expectedCount = action.files.length;
  if (verification?.verified) {
    return `✓ file_upload: Uploaded ${expectedCount} file(s) to ${action.selector}`;
  }
  return `⚠ file_upload: Uploaded ${expectedCount} file(s) to ${action.selector} (unverified — input reports ${verification?.count ?? 0} file(s) after upload; the page may not have observed the change)`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run server/tests/tools-interaction.test.ts -t "file_upload post-action validation"
```

Expected: 2 PASS.

- [ ] **Step 5: Run full server suite to confirm no regressions**

```bash
npx vitest run server/tests/
```

Expected: all tests pass (current baseline 555 + 2 new = 557).

- [ ] **Step 6: Commit**

```bash
git add server/src/tools/interaction.ts server/tests/tools-interaction.test.ts
git commit -m "feat: add post-action validation to file_upload"
```

---

## Task 3: Add `select_custom` post-action validation

After clicking the matching option, read back the trigger element's `textContent` (or its `aria-activedescendant`) and confirm it now reflects the selected option. React-Select and Headless UI both update the visible trigger text on selection — if it didn't change, the click didn't propagate to component state.

**Files:**
- Modify: `server/src/tools/interaction.ts` (the `select_custom` case, after the existing `await ctx.sleep(150)` post-click delay)
- Test: `server/tests/tools-interaction.test.ts`

- [ ] **Step 1: Capture the trigger text BEFORE the option click for diffing**

In `server/src/tools/interaction.ts`, locate the `select_custom` case. The detection eval at the top already returns `triggerText`. We will reuse that as the "before" snapshot and read the trigger again after the option click.

No code change in this step — just confirm `detection.triggerText` is available below the click site.

- [ ] **Step 2: Write the failing test for verified selection**

Add inside the `describe('onInteract()', ...)` block in `server/tests/tools-interaction.test.ts`:

```typescript
describe('select_custom post-action validation', () => {
  it('returns ✓ when trigger text changes to reflect the selection', async () => {
    (ctx.eval as any)
      .mockResolvedValueOnce({ found: true, triggerSelector: '.sel', triggerText: 'Choose...' }) // detect
      .mockResolvedValueOnce([]) // before-snapshot
      .mockResolvedValueOnce(undefined) // click trigger DOM fallback
      .mockResolvedValueOnce({ found: true, optionText: 'Engineering' }) // option click
      .mockResolvedValueOnce({ verified: true, currentText: 'Engineering' }); // post-click read-back

    const result = await onInteract(ctx, {
      actions: [{ type: 'select_custom', selector: '.sel', value: 'Engineering' }],
    }, {});

    expect(result.content[0].text).toContain('✓ select_custom');
    expect(result.content[0].text).toContain('Engineering');
  });

  it('returns ⚠ when trigger text is unchanged after option click', async () => {
    (ctx.eval as any)
      .mockResolvedValueOnce({ found: true, triggerSelector: '.sel', triggerText: 'Choose...' })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ found: true, optionText: 'Engineering' })
      .mockResolvedValueOnce({ verified: false, currentText: 'Choose...' });

    const result = await onInteract(ctx, {
      actions: [{ type: 'select_custom', selector: '.sel', value: 'Engineering' }],
    }, {});

    expect(result.content[0].text).toContain('⚠ select_custom');
    expect(result.content[0].text).toContain('unverified');
  });
});
```

- [ ] **Step 3: Run tests to verify both fail**

```bash
npx vitest run server/tests/tools-interaction.test.ts -t "select_custom post-action validation"
```

Expected: 2 FAIL. The mock script expects 5 evals and the current code only makes 4.

- [ ] **Step 4: Add the read-back step to `select_custom`**

In `server/src/tools/interaction.ts`, locate the existing `await ctx.sleep(150)` line near the end of the `select_custom` case. Replace it and the subsequent return with:

```typescript
      // Brief wait for selection to register
      await ctx.sleep(150);

      // Post-action read-back: confirm the trigger element's visible text changed.
      // React-Select / Headless UI / Radix Select all update the trigger label
      // on selection. If the text is identical to the pre-click snapshot, the
      // click did not propagate to component state — likely a fiber/state issue.
      const verification = await ctx.eval(`
        (() => {
          const el = ${expr};
          if (!el) return { verified: false, currentText: '' };
          const currentText = el.textContent?.trim().substring(0, 100) || '';
          const before = ${JSON.stringify(detection.triggerText)};
          return { verified: currentText !== before, currentText };
        })()
      `);

      if (verification?.verified) {
        return `✓ select_custom: Selected "${optionResult.optionText}" in custom dropdown ${triggerSelector}`;
      }
      return `⚠ select_custom: Selected "${optionResult.optionText}" in custom dropdown ${triggerSelector} (unverified — trigger text unchanged after option click; the dropdown may not have committed selection state)`;
    }
```

Note: the existing `return` on the line that read `Selected "..."` is being replaced. Make sure the closing brace `}` of the `case 'select_custom':` block remains correctly placed.

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run server/tests/tools-interaction.test.ts -t "select_custom"
```

Expected: all `select_custom` tests pass — the new 2 plus the existing 3 (handles select_custom, fails when no trigger, fails when option not found) plus the 11 OPTION_MATCHER_JS tests.

- [ ] **Step 6: Run full server suite**

```bash
npx vitest run server/tests/
```

Expected: 559 pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/tools/interaction.ts server/tests/tools-interaction.test.ts
git commit -m "feat: add post-action validation to select_custom"
```

---

## Task 4: Add `fill_form` post-action validation

DOM-level read-back: after the value setter and event dispatches, re-read `el.value` and compare to the intended value. This catches the loud failure modes (selector resolved to wrong element, input was disabled, browser rejected the value). The silent React-tracker failure mode (DOM updated but React state stale) is NOT caught by this check — that requires a fiber walk and is deferred to a follow-up plan, informed by Task 1's investigation document.

**Files:**
- Modify: `server/src/tools/forms.ts:27-86`
- Test: `server/tests/tools-forms.test.ts`

- [ ] **Step 1: Re-read Task 1's investigation document**

Read `docs/research/2026-04-08-fill-form-react-state-investigation.md` produced in Task 1. Note the **Implications for read-back strategy** section. If it recommends fiber-walk verification, scope-cut to DOM `.value` read-back only for this task and add a TODO comment in the code referencing the doc.

- [ ] **Step 2: Write the failing tests**

Add to `server/tests/tools-forms.test.ts` inside the existing `describe('onFillForm()', ...)` block:

```typescript
describe('post-action validation', () => {
  it('returns ✓ when read-back value matches intended value', async () => {
    (ctx.eval as any)
      .mockResolvedValueOnce(undefined) // mutation eval
      .mockResolvedValueOnce({ verified: true, actual: 'John' }); // read-back eval

    const result = await onFillForm(ctx, {
      fields: [{ selector: '#name', value: 'John' }],
    }, {});

    expect(result.content[0].text).toContain('✓');
    expect(result.content[0].text).toContain('#name');
  });

  it('returns ⚠ when read-back value differs from intended', async () => {
    (ctx.eval as any)
      .mockResolvedValueOnce(undefined) // mutation eval
      .mockResolvedValueOnce({ verified: false, actual: '' }); // read-back: empty string

    const result = await onFillForm(ctx, {
      fields: [{ selector: '#name', value: 'John' }],
    }, {});

    expect(result.content[0].text).toContain('⚠');
    expect(result.content[0].text).toContain('unverified');
    expect(result.content[0].text).toContain('#name');
  });

  it('verifies each field independently in a multi-field fill', async () => {
    (ctx.eval as any)
      .mockResolvedValueOnce(undefined) // field 1 mutation
      .mockResolvedValueOnce({ verified: true, actual: 'John' }) // field 1 read-back
      .mockResolvedValueOnce(undefined) // field 2 mutation
      .mockResolvedValueOnce({ verified: false, actual: '' }); // field 2 read-back

    const result = await onFillForm(ctx, {
      fields: [
        { selector: '#name', value: 'John' },
        { selector: '#email', value: 'john@test.com' },
      ],
    }, {});

    expect(result.content[0].text).toContain('✓');
    expect(result.content[0].text).toContain('⚠');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run server/tests/tools-forms.test.ts -t "post-action validation"
```

Expected: 3 FAIL. Current `onFillForm` does no read-back and returns `✓` for every field.

- [ ] **Step 4: Add the read-back to `onFillForm`**

In `server/src/tools/forms.ts`, replace the `for (const field of fields)` body with:

```typescript
  for (const field of fields) {
    const expr = ctx.getSelectorExpression(field.selector);
    await ctx.eval(`
      (async () => {
        const el = ${expr};
        if (!el) throw new Error('Element not found: ' + ${JSON.stringify(field.selector)});
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

    // Post-action read-back: confirm the DOM value reflects what we set.
    // NOTE: This catches loud failures (wrong selector, disabled input, rejected value)
    // but does NOT catch React's silent value-tracker drift. See
    // docs/research/2026-04-08-fill-form-react-state-investigation.md for the
    // tracker failure mode and the deferred fiber-walk follow-up.
    const verification = await ctx.eval(`
      (() => {
        const el = ${expr};
        if (!el) return { verified: false, actual: null };
        const actual = (el.type === 'checkbox' || el.type === 'radio')
          ? String(el.checked)
          : (el.value ?? '');
        const expected = ${JSON.stringify(String(field.value))};
        return { verified: actual === expected, actual };
      })()
    `);

    if (verification?.verified) {
      results.push(`✓ ${field.selector} = "${field.value}"`);
    } else {
      const actualStr = verification?.actual === null
        ? 'element disappeared'
        : `actual: "${verification?.actual ?? ''}"`;
      results.push(`⚠ ${field.selector} = "${field.value}" (unverified — ${actualStr})`);
    }
  }
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run server/tests/tools-forms.test.ts
```

Expected: all forms tests pass (15 existing + 3 new = 18). The existing test `dispatches focus, InputEvent, change, and blur events` may need its mock script updated to handle the additional read-back eval call — if it fails, update the mock to chain `.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ verified: true, actual: 'John' })`.

- [ ] **Step 6: Fix any pre-existing tests broken by the new eval call**

Run the forms tests. For each previously-passing test that now fails because the eval call count changed:
- `fills multiple form fields` — add `.mockResolvedValue({ verified: true, actual: 'X' })` so all eval calls succeed
- `returns raw result` — same
- `dispatches focus, InputEvent, change, and blur events` — same
- `uses native prototype setter for input elements` — same

The fix is always: ensure `ctx.eval` returns a verified read-back result for any test that doesn't explicitly script its own mock chain.

- [ ] **Step 7: Run full server suite**

```bash
npx vitest run server/tests/
```

Expected: all pass (target: 562 = 555 + 2 file_upload + 2 select_custom + 3 fill_form).

- [ ] **Step 8: Commit**

```bash
git add server/src/tools/forms.ts server/tests/tools-forms.test.ts
git commit -m "feat: add post-action validation to fill_form"
```

---

## Task 5: Update tool schema descriptions to document the new ⚠ semantics

Agents won't know what `⚠` means unless the tool descriptions tell them. Update the schemas so the agent reads "if you see ⚠, the mutation ran but read-back couldn't confirm the page state changed — re-verify before continuing."

**Files:**
- Modify: `server/src/tools/schemas.ts` (descriptions for `browser_fill_form`, and the `select_custom` / `file_upload` action descriptions inside `browser_interact`)

- [ ] **Step 1: Locate the schema entries**

Read `server/src/tools/schemas.ts` and find:
- The `browser_fill_form` tool description
- The `browser_interact` tool description (the action enum should mention `select_custom` and `file_upload`)

- [ ] **Step 2: Append a one-line semantics note to each description**

For `browser_fill_form`, append to the description:

> Returns one line per field prefixed with `✓` (verified — DOM value matches) or `⚠` (mutation ran but read-back didn't confirm; the field may need re-verification before form submission).

For `browser_interact`, append to the description (or to the per-action docs if they're separate):

> `select_custom` and `file_upload` return `✓` (verified) or `⚠` (unverified — re-check before submitting).

- [ ] **Step 3: Run schema tests if any exist**

```bash
npx vitest run server/tests/ -t "schema"
```

Expected: pass. If no schema tests exist, run the full suite as a sanity check.

- [ ] **Step 4: Build to confirm no type errors**

```bash
npm run build.server
```

Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/schemas.ts
git commit -m "docs: document ⚠ verification semantics in tool schemas"
```

---

## Task 6: Smoke-test the full validation pipeline against the audit-log failure cases

Replay a subset of the historical failure patterns from the agent feedback doc / audit log to confirm the new validation messages are useful, not noise.

**Files:**
- No new files. Read-only sanity check.

- [ ] **Step 1: Pick 3 representative failure cases from the audit log**

Re-read `docs/ax-feedback-agent-experience.md` and the audit data from the earlier `/usage-data-audit` session. Pick:
1. A `fill_form` failure on a Lever form (Resume_URL hidden field stayed empty)
2. A `select_custom` failure on a country dropdown that the new fuzzy matcher would now match
3. A `file_upload` failure on an iCIMS iframe-wrapped input

- [ ] **Step 2: For each case, write down the expected message**

For each, document:
- What the tool used to return (success silently)
- What it should now return (`✓` or `⚠` with explanation)
- Whether the new message gives the agent enough info to recover

- [ ] **Step 3: Add the analysis as a comment to the investigation doc**

Append to `docs/research/2026-04-08-fill-form-react-state-investigation.md` a section titled `## Validation Smoke Test (Task 6)` with the three case analyses.

- [ ] **Step 4: Commit**

```bash
git add docs/research/2026-04-08-fill-form-react-state-investigation.md
git commit -m "docs: smoke-test post-action validation against audit failure cases"
```

---

## Self-Review Checklist (already done — recording for the executing engineer)

- **Spec coverage:** All three tools (`fill_form`, `select_custom`, `file_upload`) get post-action validation. The React state investigation runs as Task 1 and informs Task 4. Tool schemas updated in Task 5.
- **Out of scope (intentional):**
  - React fiber-walk verification — deferred until Task 1's investigation gives a clear hypothesis worth implementing.
  - A shared `verification` helper — YAGNI; each tool's read-back is ~10 lines and the patterns differ enough that abstraction would obscure them.
  - Audit logger surfacing of `⚠` results as a separate field — that's Feature #3 (backend audit logging) on the unrelated features list.
- **Type consistency:** All read-back evals return `{ verified: boolean, ... }` shape. The existing `onInteract` aggregator already prefixes `✓`/`✗` based on result strings — `⚠` is a new prefix the aggregator doesn't need to know about, since each handler returns the formatted string itself.
- **Failure modes the validation does NOT catch:**
  - React internal state drift when DOM value matches (need fiber walk)
  - File upload that succeeds on disk but fails on the server's mime/size check
  - Custom dropdowns where the trigger text doesn't update on selection (rare but possible; would report `⚠` as a false positive)
  - All of these are documented in the warning message so the agent knows the verification is best-effort, not exhaustive.
