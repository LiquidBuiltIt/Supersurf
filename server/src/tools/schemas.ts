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

import type { ToolSchema } from './types';

/** Returns all core (non-experimental) tool schemas. */
export function getToolSchemas(): ToolSchema[] {
  return [
    // ── Tab Management ──
    {
      name: 'browser_tabs',
      description:
        'List, create, attach, or close browser tabs. Attach to a tab before using other browser tools.',
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
      description:
        'Run a sequence of page interactions: click, type, press keys, hover, scroll, wait, select, upload files, or force pseudo-states.',
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
                    'scroll_into_view', 'select_option', 'file_upload', 'force_pseudo_state',
                  ],
                  description: 'Type of interaction',
                },
                selector: { type: 'string', description: 'CSS selector for the target element' },
                text: { type: 'string', description: 'Text to type (for type action)' },
                key: { type: 'string', description: 'Key to press (for press_key action)' },
                value: { type: 'string', description: 'Option value or text (for select_option)' },
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
                timeout: { type: 'number', description: 'Timeout in ms (for wait action)' },
              },
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
      description:
        'Find elements by visible text and return their selectors. Use this to locate the right target before clicking.',
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
      description:
        'Pull page content as clean markdown. Auto-detects the main article, or target a specific selector. Supports pagination via offset.',
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
      description:
        'Inspect computed and matched CSS rules for an element, like the DevTools Styles panel. Supports pseudo-state forcing.',
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
      description:
        'Capture a screenshot. Defaults to JPEG quality 80, viewport-only. Options: full page, element crop, coordinate clip, clickable highlights.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format (default: jpeg)' },
          fullPage: { type: 'boolean', description: 'Full page (default: false)' },
          quality: { type: 'number', description: 'JPEG quality 0-100 (default: 80)' },
          path: { type: 'string', description: 'File path to save (returns data if omitted)' },
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
      description:
        'Run JavaScript in the page context and return the result. ' +
        'When the `secure_eval` experiment is enabled, code is analyzed for dangerous patterns ' +
        '(network calls, storage access, code injection, obfuscation) and blocked if unsafe.',
      inputSchema: {
        type: 'object',
        properties: {
          function: { type: 'string', description: 'JavaScript function to execute' },
          expression: { type: 'string', description: 'JavaScript expression to evaluate' },
        },
      },
      annotations: { title: 'Evaluate JS', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
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
      description: 'Set values on multiple form fields at once.',
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
      description:
        'Monitor network traffic: list captured requests, inspect details, replay a request, or clear the log. Filter by URL, method, status, or resource type.',
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
      description: 'Accept or dismiss a browser dialog (alert, confirm, prompt).',
      inputSchema: {
        type: 'object',
        properties: {
          accept: { type: 'boolean', description: 'Accept or dismiss' },
          text: { type: 'string', description: 'Text for prompt dialog' },
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
    {
      name: 'browser_reload_extensions',
      description: 'Reload an unpacked (developer) extension by name.',
      inputSchema: {
        type: 'object',
        properties: {
          extensionName: { type: 'string', description: 'Extension name to reload (must be unpacked)' },
        },
      },
      annotations: { title: 'Reload extensions', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
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
      description:
        'Download a file from a URL. The file is downloaded by the browser and optionally moved to a specified destination path.',
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
      description:
        'Fill a form field with a server-side credential from an environment variable. The value never reaches the agent. Types char-by-char with randomized delays.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of the input field' },
          credential_env: {
            type: 'string',
            description: 'Name of the environment variable holding the credential (e.g., "MY_PASSWORD")',
          },
        },
        required: ['selector', 'credential_env'],
      },
      annotations: { title: 'Secure credential fill', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
  ];
}
