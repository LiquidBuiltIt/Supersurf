# Audit Fixes Round 2 — Feature Additions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate ~1,168 evaluate calls/session by adding a `select_custom` interact action for JS-driven dropdowns and enriching snapshot/lookup with structured form data.

**Architecture:** Two independent features. Feature 1 adds a new action type to `browser_interact` that detects and operates React Select, Headless UI, Radix, and generic `[role="listbox"]` dropdowns via click+wait+click sequences. Feature 2 adds a `forms` section to `browser_snapshot` output and a `formFields` array to `browser_lookup` results, so agents can read form state without dropping to evaluate.

**Tech Stack:** TypeScript, Vitest, content script eval (isolated world)

---

## Feature 1: `select_custom` action for `browser_interact`

### Task 1: Add `select_custom` to the interact schema

**Files:**
- Modify: `server/src/tools/schemas.ts:84-88` (action enum)
- Modify: `server/src/tools/schemas.ts:94` (value property description)

- [ ] **Step 1: Update the action enum to include `select_custom`**

In `server/src/tools/schemas.ts`, add `'select_custom'` to the enum array at line 84-88:

```typescript
enum: [
  'click', 'type', 'clear', 'press_key', 'hover',
  'mouse_move', 'mouse_click', 'scroll_to', 'scroll_by',
  'scroll_into_view', 'select_option', 'select_custom', 'file_upload', 'force_pseudo_state',
],
```

- [ ] **Step 2: Update the `value` property description**

Change line 94 from:
```typescript
value: { type: 'string', description: 'Option value or text (for select_option)' },
```
to:
```typescript
value: { type: 'string', description: 'Option value or text (for select_option and select_custom)' },
```

- [ ] **Step 3: Update the `browser_interact` tool description**

Change line 72 from:
```typescript
'Run a sequence of page interactions: click, type, press keys, hover, scroll, wait, select, upload files, or force pseudo-states.',
```
to:
```typescript
'Run a sequence of page interactions: click, type, press keys, hover, scroll, wait, select (native or custom dropdowns), upload files, or force pseudo-states.',
```

- [ ] **Step 4: Commit**

```bash
git add server/src/tools/schemas.ts
git commit -m "feat: add select_custom to browser_interact schema"
```

### Task 2: Write failing tests for `select_custom`

**Files:**
- Modify: `server/tests/tools-interaction.test.ts`

- [ ] **Step 1: Write test — opens custom dropdown, selects option, returns result**

Add after the existing `select_option` / `file_upload` tests (before the "Unknown action" section around line 143):

```typescript
// ── Select custom dropdown ──

it('handles select_custom by clicking trigger, waiting, then clicking option', async () => {
  // Mock eval to return the detected option text
  (ctx.eval as any)
    .mockResolvedValueOnce({ found: true, triggerSelector: '.my-select', triggerText: 'Choose...' }) // detect
    .mockResolvedValueOnce(undefined) // click trigger
    .mockResolvedValueOnce({ found: true, optionText: 'Engineering' }) // find & click option
    .mockResolvedValueOnce(undefined); // verify selection

  const result = await onInteract(ctx, {
    actions: [{ type: 'select_custom', selector: '.my-select', value: 'Engineering' }],
  }, {});

  expect(result.content[0].text).toContain('✓ select_custom');
  expect(result.content[0].text).toContain('Engineering');
  expect(ctx.eval).toHaveBeenCalled();
});

it('select_custom fails when no dropdown trigger found', async () => {
  (ctx.eval as any).mockResolvedValueOnce({ found: false });

  const result = await onInteract(ctx, {
    actions: [{ type: 'select_custom', selector: '.nonexistent', value: 'Foo' }],
  }, {});

  expect(result.content[0].text).toContain('✗ select_custom');
});

it('select_custom fails when option not found in listbox', async () => {
  (ctx.eval as any)
    .mockResolvedValueOnce({ found: true, triggerSelector: '.my-select', triggerText: 'Choose...' })
    .mockResolvedValueOnce(undefined) // click trigger
    .mockResolvedValueOnce({ found: false, available: ['Design', 'Marketing'] }); // option not found

  const result = await onInteract(ctx, {
    actions: [{ type: 'select_custom', selector: '.my-select', value: 'Engineering' }],
  }, {});

  expect(result.content[0].text).toContain('✗ select_custom');
  expect(result.content[0].text).toContain('not found');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/tools-interaction.test.ts --reporter=verbose`
Expected: 3 new tests FAIL (select_custom case doesn't exist in the switch)

- [ ] **Step 3: Commit**

```bash
git add server/tests/tools-interaction.test.ts
git commit -m "test: add failing tests for select_custom interact action"
```

### Task 3: Implement `select_custom` action

**Files:**
- Modify: `server/src/tools/interaction.ts:315` (add new case before `select_option`)

- [ ] **Step 1: Add the `select_custom` case to `executeAction()`**

Insert this case after the `select_option` case (after line 340) and before `file_upload`:

```typescript
case 'select_custom': {
  const triggerSelector = action.selector;
  const targetValue = action.value as string;
  if (!triggerSelector) throw new Error('select_custom requires a selector');
  if (!targetValue) throw new Error('select_custom requires a value');

  const expr = ctx.getSelectorExpression(triggerSelector);

  // Step 1: Detect the dropdown trigger element
  const detection = await ctx.eval(`
    (() => {
      const el = ${expr};
      if (!el) return { found: false };

      // Check common custom dropdown patterns
      const isCustomSelect =
        el.getAttribute('role') === 'combobox' ||
        el.getAttribute('role') === 'listbox' ||
        el.getAttribute('aria-haspopup') === 'listbox' ||
        el.getAttribute('aria-haspopup') === 'true' ||
        el.classList.contains('css-1s2u09g-control') || // React Select
        el.querySelector('[class*="indicatorContainer"]') || // React Select
        el.getAttribute('data-headlessui-state') !== null ||
        el.getAttribute('data-radix-select-trigger') !== null ||
        el.getAttribute('data-state') !== null;

      if (!isCustomSelect) {
        // Fallback: check if any ancestor/sibling looks like a custom select
        const parent = el.closest('[role="combobox"], [role="listbox"], [aria-haspopup="listbox"], [data-headlessui-state], [data-radix-select-trigger]');
        if (!parent) return { found: false };
      }

      return {
        found: true,
        triggerSelector: ${JSON.stringify(triggerSelector)},
        triggerText: el.textContent?.trim().substring(0, 100) || '',
      };
    })()
  `);

  if (!detection?.found) {
    throw new Error(`No custom dropdown trigger found at ${triggerSelector}. Use select_option for native <select> elements.`);
  }

  // Step 2: Click the trigger to open the dropdown
  const { x, y } = await ctx.getElementCenter(triggerSelector);
  await moveCursorTo(ctx, x, y, '_default');
  await ctx.cdp('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1,
  });
  await ctx.sleep(78 + Math.floor(Math.random() * 64));
  await ctx.cdp('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
  });
  await ctx.eval(`(() => {
    const el = document.elementFromPoint(${x}, ${y});
    if (el) el.click();
  })()`).catch(() => {});

  // Wait for dropdown to render
  await ctx.sleep(300);

  // Step 3: Find and click the target option
  const optionResult = await ctx.eval(`
    (() => {
      const target = ${JSON.stringify(targetValue)};
      const targetLower = target.toLowerCase();

      // Search for options in open listbox/menu
      const optionSelectors = [
        '[role="option"]',
        '[role="menuitem"]',
        '[data-headlessui-state] li',
        '[class*="option"]',
        '[class*="menu"] [class*="option"]',
        '[id*="listbox"] [role="option"]',
        '[id*="react-select"] [id*="option"]',
      ];

      for (const sel of optionSelectors) {
        const options = document.querySelectorAll(sel);
        for (const opt of options) {
          const text = opt.textContent?.trim() || '';
          const value = opt.getAttribute('data-value') || opt.getAttribute('value') || '';
          if (text.toLowerCase() === targetLower || value.toLowerCase() === targetLower) {
            opt.scrollIntoView({ block: 'nearest' });
            opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            opt.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            opt.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return { found: true, optionText: text || value };
          }
        }
      }

      // Collect available options for error message
      const available = [];
      for (const sel of optionSelectors) {
        for (const opt of document.querySelectorAll(sel)) {
          const t = opt.textContent?.trim();
          if (t && !available.includes(t)) available.push(t);
        }
      }
      return { found: false, available: available.slice(0, 20) };
    })()
  `);

  if (!optionResult?.found) {
    const availableMsg = optionResult?.available?.length
      ? ` Available: ${optionResult.available.join(', ')}`
      : '';
    throw new Error(`Option "${targetValue}" not found in dropdown.${availableMsg}`);
  }

  // Brief wait for selection to register
  await ctx.sleep(150);

  return `Selected "${optionResult.optionText}" in custom dropdown ${triggerSelector}`;
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/tools-interaction.test.ts --reporter=verbose`
Expected: All tests PASS including 3 new select_custom tests

- [ ] **Step 3: Commit**

```bash
git add server/src/tools/interaction.ts
git commit -m "feat: implement select_custom action for JS-driven dropdowns"
```

### Task 4: Run full server test suite

**Files:** None (verification only)

- [ ] **Step 1: Run all server tests**

Run: `cd server && npx vitest run --reporter=verbose`
Expected: All tests pass. Pre-existing sandbox failures in bridge/logger/daemon-client are expected and not caused by these changes.

- [ ] **Step 2: Commit if any adjustments were needed**

---

## Feature 2: Enriched snapshot/lookup with form field data

### Task 5: Write failing tests for enriched snapshot

**Files:**
- Modify: `server/tests/tools-content.test.ts`

- [ ] **Step 1: Write test — snapshot includes form fields section**

Add to the `onSnapshot()` describe block after the existing tests:

```typescript
it('includes form fields section when forms are present', async () => {
  (ctx.ext.sendCmd as any).mockResolvedValue({
    nodes: [
      { role: { value: 'textbox' }, name: { value: 'Email' }, depth: 1 },
    ],
    formFields: [
      { selector: 'input#email', tag: 'input', type: 'email', name: 'email', value: '', required: true, label: 'Email' },
      { selector: 'select#role', tag: 'select', type: null, name: 'role', value: 'engineer', required: false, label: 'Role', options: ['designer', 'engineer', 'pm'] },
    ],
  });

  const result = await onSnapshot(ctx, {});
  expect(result.content[0].text).toContain('Form Fields');
  expect(result.content[0].text).toContain('input#email');
  expect(result.content[0].text).toContain('email');
  expect(result.content[0].text).toContain('required');
  expect(result.content[0].text).toContain('select#role');
  expect(result.content[0].text).toContain('engineer');
  expect(result.content[0].text).toContain('designer');
});

it('omits form fields section when no forms present', async () => {
  (ctx.ext.sendCmd as any).mockResolvedValue({
    nodes: [
      { role: { value: 'heading' }, name: { value: 'Welcome' }, depth: 0 },
    ],
  });

  const result = await onSnapshot(ctx, {});
  expect(result.content[0].text).not.toContain('Form Fields');
});

it('includes form fields in raw result', async () => {
  const mockData = {
    nodes: [{ role: { value: 'button' } }],
    formFields: [{ selector: 'input#name', tag: 'input', type: 'text', name: 'name', value: 'John' }],
  };
  (ctx.ext.sendCmd as any).mockResolvedValue(mockData);
  const result = await onSnapshot(ctx, { rawResult: true });
  expect(result.formFields).toBeDefined();
  expect(result.formFields[0].selector).toBe('input#name');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/tools-content.test.ts --reporter=verbose`
Expected: 3 new snapshot tests FAIL (form fields not in output)

- [ ] **Step 3: Commit**

```bash
git add server/tests/tools-content.test.ts
git commit -m "test: add failing tests for form fields in snapshot output"
```

### Task 6: Implement form field collection in snapshot

**Files:**
- Modify: `server/src/tools/content.ts:18-38` (onSnapshot function)

- [ ] **Step 1: Update `onSnapshot()` to collect and render form fields**

Replace the `onSnapshot` function in `server/src/tools/content.ts`:

```typescript
export async function onSnapshot(ctx: ToolContext, options: any): Promise<any> {
  const result = await ctx.ext.sendCmd('snapshot', {});

  // Collect form field data via content script
  const formFields = await ctx.eval(`
    (() => {
      const fields = [];
      const inputs = document.querySelectorAll('input, textarea, select');
      for (const el of inputs) {
        if (el.type === 'hidden') continue;
        let sel = el.tagName.toLowerCase();
        if (el.id) sel += '#' + el.id;
        else if (el.name) sel += '[name="' + el.name + '"]';
        else if (el.className && typeof el.className === 'string') {
          const cls = el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2);
          if (cls.length) sel += '.' + cls.join('.');
        }

        const field = {
          selector: sel,
          tag: el.tagName.toLowerCase(),
          type: el.type || null,
          name: el.name || null,
          value: el.tagName === 'SELECT' ? el.value : (el.value || ''),
          required: el.required || false,
          label: null,
        };

        // Find associated label
        if (el.id) {
          const label = document.querySelector('label[for="' + el.id + '"]');
          if (label) field.label = label.textContent?.trim() || null;
        }
        if (!field.label && el.closest('label')) {
          field.label = el.closest('label').textContent?.trim() || null;
        }
        if (!field.label) {
          field.label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || null;
        }

        // Collect options for select elements
        if (el.tagName === 'SELECT') {
          field.options = Array.from(el.options).map(o => o.textContent?.trim() || o.value);
        }

        // Checkbox/radio: include checked state
        if (el.type === 'checkbox' || el.type === 'radio') {
          field.checked = el.checked;
        }

        fields.push(field);
      }
      return fields;
    })()
  `).catch(() => []);

  if (options.rawResult) {
    return { ...result, formFields: formFields || [] };
  }

  const nodes = result?.nodes || [];
  if (nodes.length === 0 && (!formFields || formFields.length === 0)) {
    return { content: [{ type: 'text', text: 'Empty accessibility tree' }] };
  }

  // Render accessibility tree
  let output = '';
  for (const node of nodes) {
    const role = node.role?.value || '';
    const name = node.name?.value || '';
    if (!role || role === 'none' || role === 'generic') continue;
    const indent = '  '.repeat(node.depth || 0);
    output += `${indent}[${role}] ${name}\n`;
  }

  if (!output) output = 'No meaningful accessibility nodes\n';

  // Render form fields section
  if (formFields && formFields.length > 0) {
    output += '\n---\n### Form Fields\n\n';
    for (const f of formFields) {
      const parts = [`\`${f.selector}\``];
      if (f.label) parts.push(`label="${f.label}"`);
      if (f.type) parts.push(`type=${f.type}`);
      if (f.required) parts.push('**required**');
      if (f.checked !== undefined) parts.push(f.checked ? 'checked' : 'unchecked');
      if (f.value) parts.push(`value="${f.value}"`);
      if (f.options) parts.push(`options=[${f.options.join(', ')}]`);
      output += `- ${parts.join(' | ')}\n`;
    }
  }

  return { content: [{ type: 'text', text: output }] };
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/tools-content.test.ts --reporter=verbose`
Expected: All tests PASS including 3 new form field tests

- [ ] **Step 3: Commit**

```bash
git add server/src/tools/content.ts
git commit -m "feat: enrich snapshot with structured form field data"
```

### Task 7: Write failing tests for enriched lookup

**Files:**
- Modify: `server/tests/tools-content.test.ts`

- [ ] **Step 1: Write test — lookup includes form field info when match is an input**

Add to the `onLookup()` describe block:

```typescript
it('includes form field metadata for input elements', async () => {
  (ctx.eval as any).mockResolvedValue({
    matches: [
      {
        selector: 'input#email',
        visible: true,
        text: '',
        tag: 'input',
        x: 100, y: 200,
        width: 300, height: 40,
        formField: { type: 'email', name: 'email', value: 'test@x.com', required: true, label: 'Email Address' },
      },
    ],
    total: 1,
  });

  const result = await onLookup(ctx, { text: 'Email' }, {});
  expect(result.content[0].text).toContain('type=email');
  expect(result.content[0].text).toContain('value="test@x.com"');
  expect(result.content[0].text).toContain('required');
  expect(result.content[0].text).toContain('Email Address');
});

it('includes select options in lookup form field metadata', async () => {
  (ctx.eval as any).mockResolvedValue({
    matches: [
      {
        selector: 'select#dept',
        visible: true,
        text: 'Engineering',
        tag: 'select',
        x: 100, y: 200,
        width: 200, height: 40,
        formField: { type: null, name: 'department', value: 'eng', required: false, label: 'Department', options: ['Design', 'Engineering', 'PM'] },
      },
    ],
    total: 1,
  });

  const result = await onLookup(ctx, { text: 'Engineering' }, {});
  expect(result.content[0].text).toContain('options:');
  expect(result.content[0].text).toContain('Design');
  expect(result.content[0].text).toContain('Engineering');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/tools-content.test.ts --reporter=verbose`
Expected: 2 new lookup tests FAIL (form field metadata not rendered)

- [ ] **Step 3: Commit**

```bash
git add server/tests/tools-content.test.ts
git commit -m "test: add failing tests for form field metadata in lookup"
```

### Task 8: Implement form field metadata in lookup

**Files:**
- Modify: `server/src/tools/content.ts:46-108` (onLookup function)

- [ ] **Step 1: Enrich the lookup eval to collect form field data**

In `onLookup()`, update the `ctx.eval` block. After the `matches.push(...)` call (around line 83), add form field metadata collection inside the existing `for` loop:

Add this after the `height: Math.round(rect.height),` line, inside the object being pushed to `matches`:

```typescript
formField: (() => {
  const t = el.tagName;
  if (t !== 'INPUT' && t !== 'TEXTAREA' && t !== 'SELECT') return undefined;
  const ff = {
    type: el.type || null,
    name: el.name || null,
    value: t === 'SELECT' ? el.value : (el.value || ''),
    required: el.required || false,
    label: null,
  };
  if (el.id) {
    const lbl = document.querySelector('label[for="' + el.id + '"]');
    if (lbl) ff.label = lbl.textContent?.trim() || null;
  }
  if (!ff.label && el.closest('label')) ff.label = el.closest('label').textContent?.trim() || null;
  if (!ff.label) ff.label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || null;
  if (t === 'SELECT') {
    ff.options = Array.from(el.options).map(o => o.textContent?.trim() || o.value);
  }
  if (el.type === 'checkbox' || el.type === 'radio') ff.checked = el.checked;
  return ff;
})(),
```

- [ ] **Step 2: Update the lookup output formatter to render form field data**

In the `matches.forEach` block (around line 101-105), add form field rendering after the Position line:

```typescript
matches.forEach((m: any, i: number) => {
  const vis = m.visible ? '✓' : '✗ hidden';
  output += `${i + 1}. **${m.selector}** [${m.tag}] ${vis}\n`;
  output += `   Text: "${m.text}"\n   Position: (${m.x}, ${m.y}) | Size: ${m.width}×${m.height}px\n`;
  if (m.formField) {
    const f = m.formField;
    const parts: string[] = [];
    if (f.label) parts.push(`label="${f.label}"`);
    if (f.type) parts.push(`type=${f.type}`);
    if (f.required) parts.push('required');
    if (f.checked !== undefined) parts.push(f.checked ? 'checked' : 'unchecked');
    if (f.value) parts.push(`value="${f.value}"`);
    if (f.options) parts.push(`options: [${f.options.join(', ')}]`);
    output += `   Form: ${parts.join(' | ')}\n`;
  }
  output += '\n';
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/tools-content.test.ts --reporter=verbose`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add server/src/tools/content.ts
git commit -m "feat: enrich lookup with form field metadata for input elements"
```

### Task 9: Run full server test suite

**Files:** None (verification only)

- [ ] **Step 1: Run all server tests**

Run: `cd server && npx vitest run --reporter=verbose`
Expected: All tests pass (except pre-existing sandbox failures in bridge/logger/daemon-client).

- [ ] **Step 2: Build to verify no type errors**

Run: `npm run build.server`
Expected: Build succeeds with no errors.

- [ ] **Step 3: Final commit if any adjustments were needed**

```bash
git add -A
git commit -m "feat: audit fixes round 2 — select_custom action + enriched form data in snapshot/lookup"
```
