"use strict";
/**
 * Tool schema definitions for all browser tools.
 *
 * Each schema describes a single MCP tool: its name, description,
 * JSON Schema input, and MCP annotations. These are registered with
 * the MCP server and exposed to AI agents as callable tools.
 *
 * Tools are grouped by category: tab management, navigation, interaction,
 * content extraction, styles, screenshots, evaluation, console, forms,
 * drag, window, verification, network, PDF, dialogs, extensions,
 * performance, downloads, and secure credential fill.
 *
 * @module tools/schemas
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getToolSchemas = getToolSchemas;
/** Returns all core (non-experimental) tool schemas. */
function getToolSchemas() {
    const schemas = [
        // ── Tab Management ──
        {
            name: 'browser_tabs',
            description: 'List, create, attach, or close browser tabs. Attach to a tab before using other browser tools.',
            inputSchema: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['list', 'new', 'attach', 'close'],
                        description: 'Action to perform',
                    },
                    url: { type: 'string', description: 'URL to navigate to (for new action)' },
                    index: { type: 'number', description: 'Tab index (for attach/close actions)' },
                    tabId: { type: 'number', description: 'Tab ID (alternative to index for attach action — more stable than index ordering)' },
                    activate: {
                        type: 'boolean',
                        description: 'Bring tab to foreground (default: true for new, false for attach)',
                    },
                    stealth: { type: 'boolean', description: 'Enable stealth mode to avoid bot detection' },
                },
                required: ['action'],
            },
            annotations: { title: 'Manage tabs', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        },
        // ── Navigation ──
        {
            name: 'browser_navigate',
            description: 'Go to a URL, navigate back/forward, or reload the current page.',
            inputSchema: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['url', 'back', 'forward', 'reload', 'test_page'],
                        description: 'Navigation action',
                    },
                    url: { type: 'string', description: 'URL to navigate to (required when action=url)' },
                    screenshot: { type: 'boolean', description: 'Capture a screenshot after the action completes (default: false)' },
                },
                required: ['action'],
            },
            annotations: { title: 'Navigate', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        },
        // ── Interaction ──
        {
            name: 'browser_interact',
            description: 'Run a sequence of page interactions: click, type, press keys, hover, scroll, wait, select (native or custom dropdowns), upload files, or force pseudo-states. ' +
                '`select_custom` and `file_upload` return `✓` (verified) or `⚠` (unverified — re-check before submitting).',
            inputSchema: {
                type: 'object',
                properties: {
                    actions: {
                        type: 'array',
                        description: 'Array of actions to perform in sequence',
                        items: {
                            type: 'object',
                            properties: {
                                type: {
                                    type: 'string',
                                    enum: [
                                        'click', 'type', 'clear', 'press_key', 'hover', 'wait',
                                        'mouse_move', 'mouse_click', 'scroll_to', 'scroll_by',
                                        'scroll_into_view', 'select_option', 'select_custom', 'file_upload', 'force_pseudo_state',
                                    ],
                                    description: 'Type of interaction. ' +
                                        'wait: if selector is provided, polls for the element every 100ms and resolves immediately when found (rejects on timeout). ' +
                                        'If only timeout is provided, pauses for that fixed duration.',
                                },
                                selector: {
                                    type: 'string',
                                    description: 'CSS selector for the target element. Supports :has-text("...") for text matching, ' +
                                        'e.g. button:has-text("Submit"). For wait: element to poll for existence. ' +
                                        'You may also pass a handle you named earlier — a bare multi-word snake_case name ' +
                                        'such as "tweet_button" (no dots, hashes, brackets or spaces) — and the server ' +
                                        'resolves it to the element that name was recorded against on this exact domain + ' +
                                        'URL path (no cross-route matching), healing it if the page changed. Only works ' +
                                        'when the `fingerprinting` experiment is enabled (off by default) — otherwise the ' +
                                        'handle is not recognized and falls through to the CSS path. Single words are ' +
                                        'always read as CSS tag selectors, never handles.',
                                },
                                text: { type: 'string', description: 'Text to type (for type action)' },
                                key: { type: 'string', description: 'Key to press (for press_key action)' },
                                value: { type: 'string', description: 'Option value or text (for select_option and select_custom)' },
                                pseudoStates: {
                                    type: 'array',
                                    items: { type: 'string', enum: ['hover', 'active', 'focus', 'visited', 'focus-within'] },
                                    description: 'Pseudo-states to force',
                                },
                                files: { type: 'array', items: { type: 'string' }, description: 'File paths (for file_upload)' },
                                x: { type: 'number', description: 'X coordinate in viewport pixels' },
                                y: { type: 'number', description: 'Y coordinate in viewport pixels' },
                                button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button' },
                                clickCount: { type: 'number', description: 'Number of clicks (default: 1)' },
                                timeout: { type: 'number', description: 'Timeout in ms (for wait action). With selector: max wait before rejecting. Without selector: fixed delay. Default: 30000ms.' },
                                name: {
                                    type: 'string',
                                    description: 'Handle identity — a short, stable snake_case name for the element you are acting on ' +
                                        '(e.g. "first_name_input", "submit_application"). REQUIRED for element-targeting actions ' +
                                        '(click/type/clear/hover/select_option/select_custom/file_upload). Must be at least two ' +
                                        'lowercase words joined by underscores (e.g. "first_name_input") — a name not in that shape ' +
                                        'is not recorded. Reuse the same name for the same logical element across pages. Normalized ' +
                                        'server-side. The first name an element is given sticks — a later, differing name is ' +
                                        'ignored, not recorded as a rename.',
                                },
                                purpose: {
                                    type: 'string',
                                    description: 'Intent — a short natural-language reason for this interaction (e.g. "enter applicant first name", ' +
                                        '"submit the job application"). REQUIRED for element-targeting actions. Disambiguates ' +
                                        'identical-looking elements and groups actions into workflows.',
                                },
                            },
                            // `type` is the ONLY structural requirement. The name/purpose requirement for
                            // element-targeting actions is carried in the field descriptions above as prose,
                            // deliberately NOT as a JSON Schema rule.
                            //
                            // A conditional `allOf`/`if`/`then` block lived here and was reverted: the MCP spec
                            // restricts tool inputSchema to type/properties/required, composition keywords are
                            // not part of it, and client support is unreliable (Claude Code — the primary
                            // install target — reportedly mishandles them). The failure mode is the whole tool
                            // vanishing from tools/list, not a soft degrade. It bought nothing to offset that:
                            // this server never validates tool inputs (cli.ts uses the low-level SDK `Server`,
                            // which only checks the {name, arguments} envelope), so the rule was advisory even
                            // where clients did honor it.
                            //
                            // Do not reintroduce composition keywords here without first measuring, via the
                            // expanded telemetry, whether prose alone is getting agents to supply names.
                            required: ['type'],
                        },
                    },
                    onError: {
                        type: 'string',
                        enum: ['stop', 'ignore'],
                        description: 'What to do on error: stop or ignore (default: stop)',
                    },
                    screenshot: { type: 'boolean', description: 'Capture a screenshot after the action completes (default: false)' },
                },
                required: ['actions'],
            },
            annotations: { title: 'Interact with page', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        // ── Content: Snapshot ──
        {
            name: 'browser_snapshot',
            description: 'Return the page\'s accessibility tree as a structured DOM snapshot.',
            inputSchema: { type: 'object', properties: {} },
            annotations: { title: 'DOM snapshot', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        // ── Content: Lookup ──
        {
            name: 'browser_lookup',
            description: 'Find elements by visible text and return their selectors. Use this to locate the right target before clicking.',
            inputSchema: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'Text to search for in elements' },
                    limit: { type: 'number', description: 'Max results (default: 10)' },
                },
                required: ['text'],
            },
            annotations: { title: 'Lookup elements', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        // ── Content: Extract ──
        {
            name: 'browser_extract_content',
            description: 'Pull page content as clean markdown. Auto-detects the main article, or target a specific selector. Supports pagination via offset.',
            inputSchema: {
                type: 'object',
                properties: {
                    mode: {
                        type: 'string',
                        enum: ['auto', 'full', 'selector'],
                        description: 'Extraction mode (default: auto)',
                    },
                    selector: { type: 'string', description: 'CSS selector (mode=selector only)' },
                    max_lines: { type: 'number', description: 'Max lines (default: 500)' },
                    offset: { type: 'number', description: 'Line offset for pagination (default: 0)' },
                },
            },
            annotations: { title: 'Extract content', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        // ── CSS Styles ──
        {
            name: 'browser_get_element_styles',
            description: 'Inspect computed and matched CSS rules for an element, like the DevTools Styles panel. Supports pseudo-state forcing.',
            inputSchema: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: 'CSS selector for the element' },
                    property: { type: 'string', description: 'Optional: filter to specific CSS property' },
                    pseudoState: {
                        type: 'array',
                        items: {
                            type: 'string',
                            enum: ['hover', 'active', 'focus', 'visited', 'focus-within', 'focus-visible', 'target'],
                        },
                        description: 'Optional: force pseudo-states on element',
                    },
                },
                required: ['selector'],
            },
            annotations: { title: 'Get element styles', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        // ── Screenshot ──
        {
            name: 'browser_take_screenshot',
            description: 'Capture a screenshot. Defaults to JPEG quality 80, viewport-only. When `path` is omitted, output follows `screenshot.omit_path` in config (`inline` default | `path` | `both`). Options: full page, element crop, coordinate clip, clickable highlights.',
            inputSchema: {
                type: 'object',
                properties: {
                    type: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format (default: jpeg)' },
                    fullPage: { type: 'boolean', description: 'Full page (default: false)' },
                    quality: { type: 'number', description: 'JPEG quality 0-100 (default: 80)' },
                    path: {
                        type: 'string',
                        description: 'File path to save (relative to $HOME). When omitted, behavior follows `screenshot.omit_path` in ~/.supersurf/config.json: `inline` (default, return image), `path` (temp file under OS tmpdir, text only), or `both`.',
                    },
                    highlightClickables: { type: 'boolean', description: 'Highlight clickable elements (default: false)' },
                    deviceScale: { type: 'number', description: 'Scale factor: 1=CSS pixels, 0=native resolution' },
                    selector: { type: 'string', description: 'CSS selector for partial screenshot' },
                    padding: { type: 'number', description: 'Padding around selector (default: 0)' },
                    clip_x: { type: 'number', description: 'Clip X coordinate' },
                    clip_y: { type: 'number', description: 'Clip Y coordinate' },
                    clip_width: { type: 'number', description: 'Clip width' },
                    clip_height: { type: 'number', description: 'Clip height' },
                    clip_coordinateSystem: {
                        type: 'string',
                        enum: ['viewport', 'page'],
                        description: 'Coordinate system for clip (default: viewport)',
                    },
                },
            },
            annotations: { title: 'Take screenshot', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        // ── JavaScript ──
        {
            name: 'browser_evaluate',
            description: 'Run JavaScript in the page context for **read-only computation** and return the result. ' +
                'Intended for things like reading element properties, computing values from page state, or pulling data the dedicated tools don\'t expose. ' +
                '\n\n' +
                '**This tool is NOT for:**\n' +
                '- Network calls (use the page\'s own actions, or `browser_navigate` / `browser_network_requests` to inspect traffic)\n' +
                '- Storage access (use `browser_storage`)\n' +
                '- Form filling or DOM mutation (use `browser_fill_form` or `browser_interact`)\n' +
                '- Navigation, click simulation, or scrolling (use `browser_navigate` / `browser_interact`)\n' +
                '- Code injection, obfuscation, dynamic execution, or accessing dangerous primitives\n' +
                '\n' +
                '`secure_eval` is enabled by default and blocks the patterns above via AST analysis + a Proxy membrane. ' +
                'If your code is blocked, refactor to use the dedicated tool — do not work around it. ' +
                'Operators can opt out via `SUPERSURF_DISABLE_SECURE_EVAL=1` in the server env, but this defeats RCE protection.',
            inputSchema: {
                type: 'object',
                properties: {
                    function: { type: 'string', description: 'JavaScript function to execute. Must be read-only computation.' },
                    expression: { type: 'string', description: 'JavaScript expression to evaluate. Must be read-only computation.' },
                    purpose: {
                        type: 'string',
                        description: 'Required. Explain why evaluate is needed instead of a dedicated tool ' +
                            '(browser_lookup, browser_extract_content, browser_interact, browser_fill_form, ' +
                            'browser_navigate, browser_get_element_styles, browser_storage). Logged for audit.',
                    },
                },
                required: ['purpose'],
            },
            annotations: { title: 'Evaluate JS (read-only)', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        // ── Console ──
        {
            name: 'browser_console_messages',
            description: 'Read console output from the page. Filter by level, text, or source URL.',
            inputSchema: {
                type: 'object',
                properties: {
                    level: { type: 'string', enum: ['log', 'warn', 'error', 'info', 'debug'], description: 'Filter by level' },
                    text: { type: 'string', description: 'Filter by text (case-insensitive)' },
                    url: { type: 'string', description: 'Filter by source URL' },
                    limit: { type: 'number', description: 'Max messages (default: 50)' },
                    offset: { type: 'number', description: 'Skip messages (default: 0)' },
                },
            },
            annotations: { title: 'Console messages', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        // ── Forms ──
        {
            name: 'browser_fill_form',
            description: 'Set values on multiple form fields at once. ' +
                'Returns one line per field prefixed with `✓` (verified — DOM value matches) or `⚠` (mutation ran but read-back didn\'t confirm; the field may need re-verification before form submission).',
            inputSchema: {
                type: 'object',
                properties: {
                    fields: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                selector: { type: 'string' },
                                value: { type: 'string' },
                            },
                        },
                    },
                    screenshot: { type: 'boolean', description: 'Capture a screenshot after the action completes (default: false)' },
                },
                required: ['fields'],
            },
            annotations: { title: 'Fill form', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        // ── Drag ──
        {
            name: 'browser_drag',
            description: 'Drag one element to another using simulated mouse events.',
            inputSchema: {
                type: 'object',
                properties: {
                    fromSelector: { type: 'string', description: 'Source element' },
                    toSelector: { type: 'string', description: 'Target element' },
                    screenshot: { type: 'boolean', description: 'Capture a screenshot after the action completes (default: false)' },
                },
                required: ['fromSelector', 'toSelector'],
            },
            annotations: { title: 'Drag element', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        // ── Window ──
        {
            name: 'browser_window',
            description: 'Resize, close, minimize, or maximize the browser window.',
            inputSchema: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['resize', 'close', 'minimize', 'maximize'], description: 'Window action' },
                    width: { type: 'number', description: 'Width (for resize)' },
                    height: { type: 'number', description: 'Height (for resize)' },
                    screenshot: { type: 'boolean', description: 'Capture a screenshot after the action completes (default: false)' },
                },
                required: ['action'],
            },
            annotations: { title: 'Manage window', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        // ── Verification ──
        {
            name: 'browser_verify_text_visible',
            description: 'Assert that specific text is visible on the page.',
            inputSchema: {
                type: 'object',
                properties: { text: { type: 'string', description: 'Text to find' } },
                required: ['text'],
            },
            annotations: { title: 'Verify text visible', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        {
            name: 'browser_verify_element_visible',
            description: 'Assert that an element matching the selector is visible on the page.',
            inputSchema: {
                type: 'object',
                properties: { selector: { type: 'string' } },
                required: ['selector'],
            },
            annotations: { title: 'Verify element visible', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        // ── Network ──
        {
            name: 'browser_network_requests',
            description: 'Monitor network traffic: list captured requests, inspect details, replay a request, or clear the log. Filter by URL, method, status, or resource type.',
            inputSchema: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['list', 'details', 'replay', 'clear'],
                        description: 'Action (default: list)',
                    },
                    urlPattern: { type: 'string', description: 'Filter by URL substring' },
                    method: { type: 'string', description: 'Filter by HTTP method' },
                    status: { type: 'number', description: 'Filter by status code' },
                    resourceType: { type: 'string', description: 'Filter by resource type' },
                    limit: { type: 'number', description: 'Max results (default: 20)' },
                    offset: { type: 'number', description: 'Skip for pagination (default: 0)' },
                    requestId: { type: 'string', description: 'Request ID (for details/replay)' },
                    jsonPath: { type: 'string', description: 'JSONPath query for JSON responses' },
                },
            },
            annotations: { title: 'Network requests', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        // ── PDF ──
        {
            name: 'browser_pdf_save',
            description: 'Export the current page as a PDF file.',
            inputSchema: {
                type: 'object',
                properties: { path: { type: 'string', description: 'File path for PDF output' } },
            },
            annotations: { title: 'Save as PDF', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        // ── Dialog ──
        {
            name: 'browser_handle_dialog',
            description: 'Inspect or resolve a native browser dialog (alert, confirm, prompt, beforeunload). ' +
                'Dialogs are HELD open and block the page until resolved. Use action "view" to read ' +
                'the held dialog, then "accept" (OK / supply prompt text) or "dismiss" (Cancel).',
            inputSchema: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['view', 'accept', 'dismiss'],
                        description: 'view = inspect the held dialog; accept = click OK; dismiss = click Cancel',
                    },
                    text: { type: 'string', description: 'Text to enter into a prompt dialog before accepting' },
                    accept: { type: 'boolean', description: 'Deprecated: legacy alias (true=accept, false=dismiss). Prefer action.' },
                    screenshot: { type: 'boolean', description: 'Capture a screenshot after the action completes (default: false)' },
                },
            },
            annotations: { title: 'Handle dialog', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        // ── Extensions ──
        {
            name: 'browser_list_extensions',
            description: 'List all installed Chrome extensions.',
            inputSchema: { type: 'object', properties: {} },
            annotations: { title: 'List extensions', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        // ── Performance ──
        {
            name: 'browser_performance_metrics',
            description: 'Collect Web Vitals and CDP performance metrics: FCP, LCP, CLS, TTFB, and more.',
            inputSchema: { type: 'object', properties: {} },
            annotations: { title: 'Performance metrics', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        // ── Download ──
        {
            name: 'browser_download',
            description: 'Download a file from a URL. The file is downloaded by the browser and optionally moved to a specified destination path.',
            inputSchema: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'URL of the file to download' },
                    filename: { type: 'string', description: 'Override the filename (saved under browser Downloads folder)' },
                    destination: {
                        type: 'string',
                        description: 'Destination directory or file path to move the downloaded file to. If omitted, the file stays in the browser Downloads folder.',
                    },
                },
                required: ['url'],
            },
            annotations: { title: 'Download file', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        },
        // ── Secure Fill ──
        {
            name: 'secure_fill',
            description: 'NOTE: This feature is being deprecated soon in favor of a new keychain-backed password system. It remains fully functional for now. Manage and fill credentials from server-side environment variables. Values never reach the agent. Use `list` to discover available credentials, `fill` to type one into a form field char-by-char with randomized delays.',
            inputSchema: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['fill', 'list'],
                        description: '`fill` — type a credential into a form field. `list` — return available credential env var names (names only, not values).',
                    },
                    selector: { type: 'string', description: 'CSS selector of the input field (required for `fill`)' },
                    credential_env: {
                        type: 'string',
                        description: 'Name of the environment variable holding the credential (required for `fill`, e.g., "MY_PASSWORD")',
                    },
                },
                required: ['action'],
            },
            annotations: { title: 'Secure credential fill', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
    ];
    // Inject the shared `tabId` param into every tab-scoped tool — concurrency
    // isolation for parallel callers sharing one session. One definition here
    // instead of repeating the identical property across every tool. Excludes
    // browser-global tools (extensions, downloads), buffer reads (console,
    // network — Tier 2), and browser_tabs (which has its own tabId for attach).
    const TAB_SCOPED = new Set([
        'browser_navigate', 'browser_interact', 'browser_snapshot', 'browser_lookup',
        'browser_extract_content', 'browser_get_element_styles', 'browser_take_screenshot',
        'browser_evaluate', 'browser_fill_form', 'browser_drag', 'browser_window',
        'browser_verify_text_visible', 'browser_verify_element_visible', 'browser_pdf_save',
        'browser_handle_dialog', 'browser_performance_metrics', 'secure_fill',
    ]);
    const tabIdProp = {
        type: 'number',
        description: 'Target a specific tab by id (from browser_tabs). Pin this when running concurrent ' +
            'agents so a sibling can\'t redirect your call by changing the active tab; omit to use ' +
            'the session\'s attached tab.',
    };
    for (const s of schemas) {
        if (TAB_SCOPED.has(s.name)) {
            const props = s.inputSchema.properties ?? (s.inputSchema.properties = {});
            props.tabId = tabIdProp;
        }
    }
    return schemas;
}
//# sourceMappingURL=schemas.js.map