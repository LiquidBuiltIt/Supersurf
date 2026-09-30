---
name: creating-playbooks
description: Write, validate and run SuperSurf playbooks — the strict .playbook.js format, the meta object, the supersurf object's methods, and selectors that survive reruns. Use when turning a browser flow into a replayable script, or when a playbook fails validation.
---

# Creating Playbooks

A playbook is a JavaScript file that replays a browser flow through the `supersurf` object. SuperSurf never writes playbooks. You write the file with your own file tools.

## Flow

1. Do the flow once by hand, then call `playbooks` with action `history`. It lists the actions and selectors that actually worked.
2. Write `~/.supersurf/playbooks/<name>.playbook.js`. The name is snake_case.
3. Call `playbooks` with action `validate` and the name. Fix every error it reports.
4. Show the script to the user and get their approval to run it.
5. Call `playbooks` with action `run`, the name, and `params` if the script declares any. Runs need the `fingerprinting` experiment. If it is off, the tool says how to enable it.

Use `playbooks` with action `list` or `inspect` to see what exists.

## File Rules

The validator checks the file as text. It never runs it.

| Rule | Why |
|---|---|
| Export `meta` as `export const meta = { ... }`. | The listing reads `meta` without running the file. |
| `meta` is a pure literal: no variables, calls, spread, computed keys, methods or template interpolation. | `meta` is parsed, never executed. |
| Export one default async function: `export default async function ({ supersurf, params, log })`. | The runner calls it. Its return value is the run result. |
| No `import`, `require()` or dynamic `import()`. | A playbook has no module system. |
| No `eval`, `Function`, `WebAssembly`, `Reflect` or `Proxy`. | Code generation and reflection are blocked. |
| No `process`, `global`, `globalThis`, `module`, `exports` or `Buffer`. | The sandbox has no host globals. |
| No `__proto__`, `constructor`, or `Object.getPrototypeOf` and similar. | These are sandbox-escape routes. |
| Use `log('text')`, not `console.log`. | `log` is the only output channel. |
| Call methods directly as `supersurf.click(...)`. Do not destructure or alias `supersurf`. | The validator must see every call. |
| Every element target is a plain string literal or a `const` bound once to a string literal. | Templates, concatenation, member access, params and loop variables are rejected. |
| Set `useRawSelectors: true` in `meta` to use CSS selectors. | Without it, validation rejects every CSS selector. |
| Calling `supersurf.evaluate` needs `permissions: ['eval']` in `meta`. | Without it the method does not exist. |
| A run stops after 300 seconds by default. | The sandbox wall clock kills it and reports `Timeout`. |

Element targets are the `selector` arguments, both arguments of `drag`, and a string passed to `wait`.

## The meta Object

Unknown keys are rejected. There is no `name` field: the file name is the name.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `description` | string | yes | One line, non-empty. |
| `params` | object | no | Each key maps to `{ type, required?, description? }`. `type` is `'string'`, `'number'` or `'boolean'`. |
| `profile` | string | no | Default managed profile. The caller can override it. |
| `permissions` | string[] | no | Only `'eval'` is recognised. |
| `startingPoint` | string | no | A bare domain such as `'example.com'`. It feeds the playbook hint in the status header. |
| `experiments` | boolean | no | `true` enables the experiments for this run only. Default `false`. |
| `useRawSelectors` | boolean | no | `true` allows CSS selectors as element targets. Default `false`. |

Read arguments inside the script as `params.<key>`.

## The supersurf Object

Every method is async. Import nothing. Namespaced methods take one `opts` object, and its keys are the arguments of the tool in the last column.

| Method | What it does | Maps to tool |
|---|---|---|
| `supersurf.goto(url)` | Open a URL. | `browser_navigate` |
| `supersurf.back()` / `forward()` / `reload()` | History and reload. | `browser_navigate` |
| `supersurf.click(selector)` | Click. | `browser_interact` |
| `supersurf.type(selector, text)` | Type into a field. | `browser_interact` |
| `supersurf.clear(selector)` | Clear a field. | `browser_interact` |
| `supersurf.pressKey(key)` | Press a key. | `browser_interact` |
| `supersurf.hover(selector)` | Hover. | `browser_interact` |
| `supersurf.wait(msOrSelector)` | A number waits that many ms. A string waits for that element. | `browser_interact` |
| `supersurf.mouseMove(x, y)` / `mouseClick(x, y, opts)` | Move or click at coordinates. | `browser_interact` |
| `supersurf.scrollTo(selector)` / `scrollBy(x, y)` / `scrollIntoView(selector)` | Scroll. | `browser_interact` |
| `supersurf.selectOption(selector, value)` | Choose an option in a native select. | `browser_interact` |
| `supersurf.selectCustom(selector, value)` | Choose an option in a custom dropdown. | `browser_interact` |
| `supersurf.upload(selector, files)` | Attach files to an input. | `browser_interact` |
| `supersurf.forcePseudoState(selector, states)` | Force `:hover`, `:focus` and similar. | `browser_interact` |
| `supersurf.snapshot()` | Accessibility snapshot. | `browser_snapshot` |
| `supersurf.lookup(query)` | Find elements by text. | `browser_lookup` |
| `supersurf.extract(opts)` | Extract page content. | `browser_extract_content` |
| `supersurf.styles(selector, opts)` | Read computed styles. | `browser_get_element_styles` |
| `supersurf.screenshot(opts)` | Take a screenshot. | `browser_take_screenshot` |
| `supersurf.seeText(text)` | Resolves `true` or `false`. Does not throw. | `browser_verify_text_visible` |
| `supersurf.seeElement(selector)` | Resolves `true` or `false`. Does not throw. | `browser_verify_element_visible` |
| `supersurf.fill(fields)` | Fill a form. `fields` is `{ selector: value }`. | `browser_fill_form` |
| `supersurf.drag(from, to)` | Drag one element onto another. | `browser_drag` |
| `supersurf.secureFill(selector, envName)` | Fill from an environment variable. You pass the variable name, never the value. | `secure_fill` |
| `supersurf.tabs.list(opts)` / `new` / `attach` / `close` | Tab control. | `browser_tabs` |
| `supersurf.net.requests(opts)` / `net.console(opts)` | Network log and console messages. | `browser_network_requests`, `browser_console_messages` |
| `supersurf.storage.get(opts)` / `set` / `delete` / `clear` / `list` | Web storage. | `browser_storage` |
| `supersurf.window.resize(opts)` / `close()` / `minimize()` / `maximize()` | Window control. | `browser_window` |
| `supersurf.dialog.view()` / `accept(opts)` / `dismiss()` | Handle a dialog. | `browser_handle_dialog` |
| `supersurf.pdf(opts)` | Save the page as PDF. | `browser_pdf_save` |
| `supersurf.download(opts)` | Download a file. | `browser_download` |
| `supersurf.perf()` | Performance metrics. | `browser_performance_metrics` |
| `supersurf.extensions()` | List browser extensions. | `browser_list_extensions` |
| `supersurf.evaluate(code)` | Run JavaScript in the page. Needs permission: the `eval` entry in `meta.permissions`. | `browser_evaluate` |

`evaluate` supplies its `purpose` itself. Do not pass one.

There is no `connect`, `disconnect`, profile method or nested playbook call. The runner owns the connection and opens its own tab, which it closes at the end.

## Example

```js
export const meta = {
  description: 'Search example.com and report whether a result page loaded',
  params: {
    query: { type: 'string', required: true, description: 'Search words' },
  },
  startingPoint: 'example.com',
  useRawSelectors: true,
};

export default async function ({ supersurf, params, log }) {
  log('opening the site');
  await supersurf.goto('https://example.com/');
  await supersurf.type('input[name="q"]', params.query);
  await supersurf.click('button[type="submit"]');
  await supersurf.wait('#results');
  return { loaded: await supersurf.seeElement('#results') };
}
```

## Selectors That Survive Reruns

| Prefer | Avoid |
|---|---|
| `#id` when the id is a plain word | Ids that look generated |
| `[data-testid="..."]` | Positional selectors such as `:nth-child(3)` |
| Stable `name` or `aria-label` attributes | Hash-like class names such as `.css-1x2y3z` |
| Text the page always shows | Text that changes per user, date or language |

Take selectors from `playbooks` action `history`, not from memory. When a selector misses, see `supersurf:navigation`.

## When a Run Fails

A failed run names one of six types and the step it stopped at.

| Type | Meaning |
|---|---|
| `SelectorMiss` | A selector matched nothing. The result lists candidate selectors read from the page. |
| `Timeout` | The run hit its wall clock and was killed. |
| `PageUnavailable` | No usable page: a network-error page or a crashed renderer. |
| `HarnessUnavailable` | The extension, daemon, tab or sandbox went away. |
| `Refused` | The harness declined: hash mismatch, bad params or a `secure_eval` block. |
| `ScriptAssertion` | The script threw on its own, such as a param guard or a `TypeError`. |

Every run is appended to `~/.supersurf/playbooks/<name>.runs.jsonl`. Fix the script, run `validate` again, then re-run.
