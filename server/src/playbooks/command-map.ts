/**
 * `supersurf` client method -> MCP tool call.
 *
 * Spec §7.6 puts the CLIENT method name on the wire (`{"t":"cmd","method":"click",…}`),
 * and §7.5's `runPlaybookScript` hands it to `onCommand` unchanged. `host.ts` holds
 * no `ConnectionManager`, so the translation to an MCP tool belongs on this side of
 * the pipe — here.
 *
 * The `params` shapes below are the §7.7 signatures with positional arguments
 * named after their parameters (`click(selector)` -> `{selector}`). Three of those
 * signatures do not line up one-for-one with the tool schema, and §7.7 is explicit
 * that plan authors read `server/src/tools/schemas.ts` for the exact params:
 *
 *   - `wait(msOrSelector)` is a union, so Addendum A pins its pipe key as
 *     `msOrSelector` and this map branches on the VALUE TYPE — a number is a delay,
 *     a string is a wait-for-element. Getting that branch wrong silently turns
 *     `wait('#done')` into a zero-length sleep.
 *   - `fill(fields: Record<string, string>)` is a map, but `browser_fill_form` takes
 *     an ARRAY of `{selector, value}`. Bridging the two is this module's job.
 *   - `drag(from, to)` and `secureFill(selector, envName)` land on schema parameters
 *     named `fromSelector`/`toSelector` and `credential_env`.
 *
 * `evaluate` is the last exception. The real `browser_evaluate` schema takes
 * `function`/`expression` (never `code`), and its handler HARD-REJECTS an empty
 * `purpose`. The client signature stays `evaluate(code)` per §7.7 — this map
 * supplies `purpose: 'playbook:<name>'` itself. Non-empty by construction, and it
 * makes the usage-metrics trail readable. Do NOT add a `purpose` parameter to the
 * client method.
 *
 * Namespaced passthroughs (`tabs.*`, `storage.*`, …) and the `opts?` tail of
 * `extract`/`styles`/`screenshot`/`mouseClick` arrive as a single `opts` object,
 * because that is the parameter's name in §7.7. `mapCommand` flattens it before
 * dispatch, so every mapper below sees plain named keys.
 *
 * Permission enforcement is NOT here. Spec §5 enforces by construction — an
 * ungranted method is never built onto the client object, so it can never reach
 * the pipe. This map only translates.
 *
 * @module playbooks/command-map
 */

export interface MappedCommand {
  tool: string;
  args: Record<string, unknown>;
}

type Mapper = (p: any, playbookName: string) => MappedCommand;

/** `browser_interact` takes an actions array; every client verb is one action. */
function act(type: string, fields: Record<string, unknown>): MappedCommand {
  const action: Record<string, unknown> = { type };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) action[k] = v;
  }
  return { tool: 'browser_interact', args: { actions: [action] } };
}

/** Drop undefined keys so an omitted optional never becomes an explicit `undefined`. */
function args(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * §7.7 hands `fill` a `Record<string, string>`; `browser_fill_form` wants an array
 * of `{selector, value}`. An array that is already in tool shape passes through, so
 * a script written against the schema rather than the signature still works.
 */
function fillFields(fields: unknown): unknown {
  if (Array.isArray(fields) || fields === null || typeof fields !== 'object') return fields;
  return Object.entries(fields as Record<string, unknown>).map(([selector, value]) => ({ selector, value }));
}

/** Methods the spec deliberately withholds — reported by name, not as "unknown". */
const WITHHELD = new Set([
  'connect', 'disconnect',
  'profile_create', 'profile_list', 'profile_delete',
  'playbook', 'playbooks',
]);

const MAP: Record<string, Mapper> = {
  // ── Navigation ──
  goto: (p) => ({ tool: 'browser_navigate', args: { action: 'url', url: p.url } }),
  back: () => ({ tool: 'browser_navigate', args: { action: 'back' } }),
  forward: () => ({ tool: 'browser_navigate', args: { action: 'forward' } }),
  reload: () => ({ tool: 'browser_navigate', args: { action: 'reload' } }),

  // ── Interaction (15 verbs, one per browser_interact action type) ──
  click: (p) => act('click', { selector: p.selector }),
  type: (p) => act('type', { selector: p.selector, text: p.text }),
  clear: (p) => act('clear', { selector: p.selector }),
  pressKey: (p) => act('press_key', { key: p.key }),
  hover: (p) => act('hover', { selector: p.selector }),
  wait: (p) => (typeof p.msOrSelector === 'number'
    ? act('wait', { timeout: p.msOrSelector })
    : act('wait', { selector: p.msOrSelector })),
  mouseMove: (p) => act('mouse_move', { x: p.x, y: p.y }),
  mouseClick: (p) => act('mouse_click', { x: p.x, y: p.y, button: p.button, clickCount: p.clickCount }),
  scrollTo: (p) => act('scroll_to', { selector: p.selector }),
  scrollBy: (p) => act('scroll_by', { x: p.x, y: p.y }),
  scrollIntoView: (p) => act('scroll_into_view', { selector: p.selector }),
  selectOption: (p) => act('select_option', { selector: p.selector, value: p.value }),
  selectCustom: (p) => act('select_custom', { selector: p.selector, value: p.value }),
  upload: (p) => act('file_upload', { selector: p.selector, files: p.files }),
  forcePseudoState: (p) => act('force_pseudo_state', { selector: p.selector, pseudoStates: p.states }),

  // ── Content ──
  snapshot: (p) => ({ tool: 'browser_snapshot', args: args({ ...p }) }),
  lookup: (p) => ({ tool: 'browser_lookup', args: args({ text: p.query, limit: p.limit }) }),
  extract: (p) => ({ tool: 'browser_extract_content', args: args({ ...p }) }),
  styles: (p) => ({ tool: 'browser_get_element_styles', args: args({ ...p }) }),
  screenshot: (p) => ({ tool: 'browser_take_screenshot', args: args({ ...p }) }),

  // ── Verification (client turns these into booleans) ──
  seeText: (p) => ({ tool: 'browser_verify_text_visible', args: { text: p.text } }),
  seeElement: (p) => ({ tool: 'browser_verify_element_visible', args: { selector: p.selector } }),

  // ── Forms ──
  fill: (p) => ({ tool: 'browser_fill_form', args: { fields: fillFields(p.fields) } }),
  drag: (p) => ({ tool: 'browser_drag', args: { fromSelector: p.from, toSelector: p.to } }),
  secureFill: (p) => ({ tool: 'secure_fill', args: { action: 'fill', selector: p.selector, credential_env: p.envName } }),

  // ── Namespaced passthroughs ──
  'tabs.list': (p) => ({ tool: 'browser_tabs', args: args({ action: 'list', ...p }) }),
  'tabs.new': (p) => ({ tool: 'browser_tabs', args: args({ action: 'new', ...p }) }),
  'tabs.attach': (p) => ({ tool: 'browser_tabs', args: args({ action: 'attach', ...p }) }),
  'tabs.close': (p) => ({ tool: 'browser_tabs', args: args({ action: 'close', ...p }) }),
  'net.requests': (p) => ({ tool: 'browser_network_requests', args: args({ ...p }) }),
  'net.console': (p) => ({ tool: 'browser_console_messages', args: args({ ...p }) }),
  'storage.get': (p) => ({ tool: 'browser_storage', args: args({ action: 'get', ...p }) }),
  'storage.set': (p) => ({ tool: 'browser_storage', args: args({ action: 'set', ...p }) }),
  'storage.delete': (p) => ({ tool: 'browser_storage', args: args({ action: 'delete', ...p }) }),
  'storage.clear': (p) => ({ tool: 'browser_storage', args: args({ action: 'clear', ...p }) }),
  'storage.list': (p) => ({ tool: 'browser_storage', args: args({ action: 'list', ...p }) }),
  'window.resize': (p) => ({ tool: 'browser_window', args: args({ action: 'resize', ...p }) }),
  'window.close': (p) => ({ tool: 'browser_window', args: args({ action: 'close', ...p }) }),
  'window.minimize': (p) => ({ tool: 'browser_window', args: args({ action: 'minimize', ...p }) }),
  'window.maximize': (p) => ({ tool: 'browser_window', args: args({ action: 'maximize', ...p }) }),
  'dialog.view': (p) => ({ tool: 'browser_handle_dialog', args: args({ action: 'view', ...p }) }),
  'dialog.accept': (p) => ({ tool: 'browser_handle_dialog', args: args({ action: 'accept', ...p }) }),
  'dialog.dismiss': (p) => ({ tool: 'browser_handle_dialog', args: args({ action: 'dismiss', ...p }) }),
  pdf: (p) => ({ tool: 'browser_pdf_save', args: args({ ...p }) }),
  download: (p) => ({ tool: 'browser_download', args: args({ ...p }) }),
  perf: (p) => ({ tool: 'browser_performance_metrics', args: args({ ...p }) }),
  extensions: (p) => ({ tool: 'browser_list_extensions', args: args({ ...p }) }),

  // ── Permission-gated (gate lives on the client object, spec §5) ──
  evaluate: (p, playbookName) => ({
    tool: 'browser_evaluate',
    args: { function: p.code, purpose: `playbook:${playbookName}` },
  }),
};

export const KNOWN_METHODS: string[] = Object.keys(MAP).sort();

/**
 * Flatten the `opts` parameter into its siblings. Namespaced passthroughs take a
 * single `opts` object, and `extract`/`styles`/`screenshot`/`mouseClick` take one as
 * an optional tail, so `opts` is the §7.7 parameter name that crosses the pipe.
 * Explicit sibling keys win over anything inside `opts`.
 */
function flattenOpts(p: any): any {
  if (!p || typeof p !== 'object' || p.opts === undefined) return p ?? {};
  const { opts, ...rest } = p;
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) return rest;
  return { ...opts, ...rest };
}

export function mapCommand(method: string, params: any, playbookName = 'unnamed'): MappedCommand {
  if (WITHHELD.has(method)) {
    throw new Error(`\`${method}\` is not available to playbook scripts.`);
  }
  const fn = MAP[method];
  if (!fn) {
    throw new Error(`Unknown playbook command: \`${method}\`.`);
  }
  return fn(flattenOpts(params), playbookName);
}
