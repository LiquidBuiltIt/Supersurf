import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onInteract } from '../src/tools/interaction';
import { OPTION_MATCHER_JS } from '../src/tools/interaction/option-matcher';
import type { ToolContext } from '../src/tools/lib/types';

// Build a node-callable version of the page-context matcher.
// This lets us test the same JS string that gets inlined into select_custom.
const matchOption = new Function(
  'target', 'candidates',
  OPTION_MATCHER_JS + '\nreturn matchOption(target, candidates);'
) as (target: string, candidates: Array<{ text: string; value?: string }>) => number;

// Mock experimental registry
vi.mock('../src/experimental/index', () => ({
  experimentRegistry: {
    isEnabled: vi.fn().mockReturnValue(false),
  },
  diffSnapshots: vi.fn().mockReturnValue({ added: [], removed: [], countDelta: 0 }),
  calculateConfidence: vi.fn().mockReturnValue(1.0),
  formatDiffSection: vi.fn().mockReturnValue(''),
}));

function createMockCtx(): ToolContext {
  // Default cdp mock: top-frame Runtime.evaluate reports "element exists"
  // so resolveInFrames / findElementInFrames helpers don't DFS into child
  // frames for tests that don't opt in to iframe behavior.
  const defaultCdp = vi.fn().mockImplementation(async (method: string, params: any) => {
    if (method === 'Runtime.evaluate' && (params == null || params.contextId === undefined)) {
      return { result: { objectId: 'top-obj' } };
    }
    return {};
  });
  return {
    ext: { sendCmd: vi.fn().mockResolvedValue({}) } as any,
    connectionManager: null,
    cdp: defaultCdp,
    // Default eval returns a truthy object so verification shims
    // (`{focused}`, `{scrolled}`, `{cleared}`, `{selected}`, `{verified}`)
    // don't throw for tests that don't opt in. Specific tests override as needed.
    eval: vi.fn().mockResolvedValue({ focused: true, scrolled: true, cleared: true, selected: true, optionText: 'ok', verified: true, found: true }),
    sleep: vi.fn().mockResolvedValue(undefined),
    getElementCenter: vi.fn().mockResolvedValue({ x: 50, y: 50 }),
    getSelectorExpression: vi.fn((s) => `document.querySelector("${s}")`),
    findAlternativeSelectors: vi.fn().mockResolvedValue([]),
    formatResult: vi.fn((_n, r) => ({ content: [{ type: 'text', text: JSON.stringify(r) }] })),
    error: vi.fn((msg) => ({ content: [{ type: 'text', text: msg }], isError: true })),
  };
}

describe('onInteract()', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockCtx();
  });

  // ── Click ──

  it('handles click by selector', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'click', selector: '#btn' }],
    }, {});

    expect(ctx.getElementCenter).toHaveBeenCalledWith('#btn');
    expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseMoved' }));
    expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed' }));
    expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseReleased' }));
    // DOM-level click dispatched for navigation
    expect(ctx.eval).toHaveBeenCalledWith(expect.stringContaining('.click()'));
    expect(result.content[0].text).toContain('Clicked');
  });

  it('handles click by coordinates', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'click', x: 200, y: 300 }],
    }, {});

    expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ x: 200, y: 300, type: 'mousePressed' }));
    // DOM-level click dispatched for navigation
    expect(ctx.eval).toHaveBeenCalledWith(expect.stringContaining('elementFromPoint(200, 300)'));
    expect(result.content[0].text).toContain('200, 300');
  });

  it('fails click without selector or coordinates', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'click' }],
    }, {});
    expect(result.content[0].text).toContain('✗');
    expect(result.isError).toBe(true);
  });

  // ── Type ──

  it('handles type action', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'type', text: 'hello', selector: '#input' }],
    }, {});

    // Should dispatch 5 char events (h, e, l, l, o)
    const charCalls = (ctx.cdp as any).mock.calls.filter(
      (c: any) => c[0] === 'Input.dispatchKeyEvent' && c[1]?.type === 'char'
    );
    expect(charCalls).toHaveLength(5);
    expect(result.content[0].text).toContain('Typed');
  });

  // ── Press key ──

  it('handles press_key action', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'press_key', key: 'Enter' }],
    }, {});

    expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({ type: 'keyDown', key: 'Enter' }));
    expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({ type: 'keyUp' }));
    expect(result.content[0].text).toContain('Pressed Enter');
  });

  // ── Hover ──

  it('handles hover action', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'hover', selector: '.menu' }],
    }, {});

    expect(ctx.getElementCenter).toHaveBeenCalledWith('.menu');
    expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseMoved' }));
    expect(result.content[0].text).toContain('Hovered');
  });

  // ── Wait ──

  it('handles wait with timeout', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'wait', timeout: 500 }],
    }, {});

    expect(ctx.sleep).toHaveBeenCalledWith(500);
    expect(result.content[0].text).toContain('Waited 500ms');
  });

  it('handles wait with selector', async () => {
    (ctx.eval as any).mockResolvedValue(true);
    const result = await onInteract(ctx, {
      actions: [{ type: 'wait', selector: '#loader' }],
    }, {});

    expect(result.content[0].text).toContain('Element appeared');
  });

  // ── Mouse move ──

  it('handles mouse_move action', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'mouse_move', x: 10, y: 20 }],
    }, {});

    expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ x: 10, y: 20 }));
    expect(result.content[0].text).toContain('Moved to');
  });

  // ── Scroll ──

  it('handles scroll_to action', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'scroll_to', x: 0, y: 500 }],
    }, {});
    expect(result.content[0].text).toContain('Scrolled window to');
  });

  it('handles scroll_by action', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'scroll_by', x: 0, y: 300 }],
    }, {});
    expect(result.content[0].text).toContain('Scrolled window by');
  });

  it('handles scroll_into_view action', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'scroll_into_view', selector: '#target' }],
    }, {});
    expect(result.content[0].text).toContain('Scrolled');
  });

  // ── Select custom dropdown ──

  it('handles select_custom by clicking trigger, waiting, then clicking option', async () => {
    // Mock eval to return the detected option text
    (ctx.eval as any)
      .mockResolvedValueOnce({ found: true, triggerSelector: '.my-select', triggerText: 'Choose...' }) // detect
      .mockResolvedValueOnce([]) // before-snapshot (no pre-existing options)
      .mockResolvedValueOnce(undefined) // click trigger (DOM click)
      .mockResolvedValueOnce({ found: true, optionText: 'Engineering' }) // find & click option
      .mockResolvedValueOnce({ verified: true, currentText: 'Engineering' }); // post-click read-back

    const result = await onInteract(ctx, {
      actions: [{ type: 'select_custom', selector: '.my-select', value: 'Engineering' }],
    }, {});

    expect(result.content[0].text).toContain('✓ select_custom');
    expect(result.content[0].text).toContain('Engineering');
    expect(ctx.eval).toHaveBeenCalled();
  });

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

  it('select_custom fails when no dropdown trigger found', async () => {
    (ctx.eval as any).mockResolvedValueOnce({ found: false });

    const result = await onInteract(ctx, {
      actions: [{ type: 'select_custom', selector: '.nonexistent', value: 'Foo' }],
    }, {});

    expect(result.content[0].text).toContain('✗ select_custom');
  });

  describe('select_custom OPTION_MATCHER_JS (fuzzy match)', () => {
    it('matches exactly when target equals option text', () => {
      expect(matchOption('Engineering', [{ text: 'Engineering' }, { text: 'Design' }])).toBe(0);
    });

    it('is case-insensitive', () => {
      expect(matchOption('engineering', [{ text: 'Engineering' }])).toBe(0);
    });

    it('returns -1 when no candidate matches', () => {
      expect(matchOption('Yes', [{ text: 'No' }, { text: 'Maybe' }])).toBe(-1);
    });

    it('matches "United States" to "United States +1" via startsWith (real audit failure)', () => {
      const candidates = [
        { text: 'Afghanistan +93' },
        { text: 'Albania +355' },
        { text: 'United States +1' },
        { text: 'United Kingdom +44' },
      ];
      expect(matchOption('United States', candidates)).toBe(2);
    });

    it('matches "United States" to "United States of America (+1)" via startsWith', () => {
      const candidates = [{ text: 'Canada' }, { text: 'United States of America (+1)' }];
      expect(matchOption('United States', candidates)).toBe(1);
    });

    it('matches "United States +1" to "United States+1" via alphanumeric normalization', () => {
      // Real audit case: option had no space between country and code
      const candidates = [
        { text: 'Afghanistan+93' },
        { text: 'United States+1' },
      ];
      expect(matchOption('United States +1', candidates)).toBe(1);
    });

    it('prefers shorter candidate when multiple match at same priority', () => {
      // Both candidates start with "United States" → tiebreaker: shorter wins
      const candidates = [
        { text: 'United States of America' },
        { text: 'United States +1' },
      ];
      expect(matchOption('United States', candidates)).toBe(1);
    });

    it('falls back to substring match', () => {
      const candidates = [{ text: 'Republic of the United States' }];
      expect(matchOption('United States', candidates)).toBe(0);
    });

    it('matches by value attribute too', () => {
      const candidates = [{ text: '🇺🇸 USA', value: 'United States' }];
      expect(matchOption('United States', candidates)).toBe(0);
    });

    it('handles empty inputs gracefully', () => {
      expect(matchOption('', [{ text: 'foo' }])).toBe(-1);
      expect(matchOption('foo', [])).toBe(-1);
    });

    it('exact match outranks startsWith from a longer option', () => {
      const candidates = [
        { text: 'United States of America' }, // startsWith score 2
        { text: 'United States' },             // exact score 0
      ];
      expect(matchOption('United States', candidates)).toBe(1);
    });
  });

  it('select_custom fails when option not found in listbox', async () => {
    (ctx.eval as any)
      .mockResolvedValueOnce({ found: true, triggerSelector: '.my-select', triggerText: 'Choose...' })
      .mockResolvedValueOnce([]) // before-snapshot
      .mockResolvedValueOnce(undefined) // click trigger (DOM click)
      .mockResolvedValueOnce({ found: false, available: ['Design', 'Marketing'] }); // option not found

    const result = await onInteract(ctx, {
      actions: [{ type: 'select_custom', selector: '.my-select', value: 'Engineering' }],
    }, {});

    expect(result.content[0].text).toContain('✗ select_custom');
    expect(result.content[0].text).toContain('not found');
  });

  // ── Unknown action ──

  it('fails on unknown action type', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'teleport' }],
    }, {});
    expect(result.content[0].text).toContain('✗');
    expect(result.content[0].text).toContain('Unknown action type');
  });

  // ── Multiple actions ──

  it('executes multiple actions in sequence', async () => {
    const result = await onInteract(ctx, {
      actions: [
        { type: 'click', x: 10, y: 10 },
        { type: 'press_key', key: 'Tab' },
      ],
    }, {});

    expect(result.content[0].text).toContain('Clicked');
    expect(result.content[0].text).toContain('Pressed Tab');
  });

  // ── onError behavior ──

  it('stops on first error by default', async () => {
    const result = await onInteract(ctx, {
      actions: [
        { type: 'click' }, // will fail — no selector or coords
        { type: 'press_key', key: 'Enter' }, // should not run
      ],
    }, {});

    expect(result.content[0].text).toContain('✗ click');
    expect(result.content[0].text).not.toContain('Pressed');
  });

  it('continues on error when onError=ignore', async () => {
    const result = await onInteract(ctx, {
      actions: [
        { type: 'click' }, // fails
        { type: 'press_key', key: 'Enter' },
      ],
      onError: 'ignore',
    }, {});

    expect(result.content[0].text).toContain('✗ click');
    expect(result.content[0].text).toContain('Pressed Enter');
  });

  // ── rawResult mode ──

  it('returns raw result format', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'press_key', key: 'Escape' }],
    }, { rawResult: true });

    expect(result.success).toBe(true);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toContain('Pressed Escape');
  });

  // ── Tab spawn detection ──

  it('appends spawned tab info to click response', async () => {
    (ctx.ext.sendCmd as any).mockImplementation(async (cmd: string, params: any) => {
      if (cmd === 'drainSpawnedTabs') {
        return { tabs: [{ id: 42, index: 3, url: 'https://example.com', title: 'Example' }] };
      }
      return {};
    });

    const result = await onInteract(ctx, {
      actions: [{ type: 'click', selector: '#link' }],
    }, {});

    expect(result.content[0].text).toContain('New tab(s) opened');
    expect(result.content[0].text).toContain('https://example.com');
    expect(result.content[0].text).toContain('Example');
    expect(result.content[0].text).toContain("browser_tabs action='attach'");
  });

  it('returns normal click response when no tabs spawned', async () => {
    (ctx.ext.sendCmd as any).mockImplementation(async (cmd: string) => {
      if (cmd === 'drainSpawnedTabs') return { tabs: [] };
      return {};
    });

    const result = await onInteract(ctx, {
      actions: [{ type: 'click', x: 100, y: 200 }],
    }, {});

    expect(result.content[0].text).toContain('Clicked');
    expect(result.content[0].text).not.toContain('New tab(s) opened');
  });

  it('click still works when drainSpawnedTabs throws', async () => {
    (ctx.ext.sendCmd as any).mockImplementation(async (cmd: string) => {
      if (cmd === 'drainSpawnedTabs') throw new Error('timeout');
      return {};
    });

    const result = await onInteract(ctx, {
      actions: [{ type: 'click', selector: '#btn' }],
    }, {});

    expect(result.content[0].text).toContain('Clicked');
    expect(result.isError).toBeFalsy();
  });

  it('appends spawned tab info to mouse_click response', async () => {
    (ctx.ext.sendCmd as any).mockImplementation(async (cmd: string) => {
      if (cmd === 'drainSpawnedTabs') {
        return { tabs: [{ id: 10, index: 1, url: 'https://new.tab', title: 'New' }] };
      }
      return {};
    });

    const result = await onInteract(ctx, {
      actions: [{ type: 'mouse_click', x: 50, y: 60 }],
    }, {});

    expect(result.content[0].text).toContain('New tab(s) opened');
    expect(result.content[0].text).toContain('https://new.tab');
  });

  // ── Scroll-aware page diffing ──

  it('uses viewport capture mode for scroll-only batches', async () => {
    const { experimentRegistry } = await import('../src/experimental/index');
    (experimentRegistry.isEnabled as any).mockReturnValue(true);

    await onInteract(ctx, {
      actions: [{ type: 'scroll_by', x: 0, y: 500 }],
    }, {});

    // Both before and after captures should use viewport mode
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('capturePageState', { mode: 'viewport' });
  });

  it('uses document capture mode for mixed action batches', async () => {
    const { experimentRegistry } = await import('../src/experimental/index');
    (experimentRegistry.isEnabled as any).mockReturnValue(true);

    await onInteract(ctx, {
      actions: [
        { type: 'click', x: 10, y: 10 },
        { type: 'scroll_by', x: 0, y: 500 },
      ],
    }, {});

    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('capturePageState', { mode: 'document' });
  });

  it('sleeps 350ms before after-capture for scroll-only batches', async () => {
    const { experimentRegistry } = await import('../src/experimental/index');
    (experimentRegistry.isEnabled as any).mockReturnValue(true);

    await onInteract(ctx, {
      actions: [{ type: 'scroll_to', x: 0, y: 1000 }],
    }, {});

    // sleep(350) should be called for scroll settlement
    expect(ctx.sleep).toHaveBeenCalledWith(350);
  });

  describe('file_upload post-action validation', () => {
    it('returns ✓ when files are present after upload', async () => {
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

    it('walks into child frames when top frame has no match', async () => {
      // Top frame query returns no objectId → walk frames
      // Frame tree has root + child frame; child frame contains the input
      (ctx.cdp as any).mockImplementation((method: string, params?: any) => {
        if (method === 'Runtime.evaluate' && !params?.contextId) {
          // Top-frame query: no match
          return Promise.resolve({ result: { type: 'object', subtype: 'null', value: null } });
        }
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({
            frameTree: {
              frame: { id: 'root-frame', url: 'https://example.com' },
              childFrames: [
                {
                  frame: { id: 'child-frame-1', url: 'https://iframe.example.com' },
                },
              ],
            },
          });
        }
        if (method === 'Page.createIsolatedWorld' && params?.frameId === 'root-frame') {
          return Promise.resolve({ executionContextId: 100 });
        }
        if (method === 'Page.createIsolatedWorld' && params?.frameId === 'child-frame-1') {
          return Promise.resolve({ executionContextId: 200 });
        }
        if (method === 'Runtime.evaluate' && params?.contextId === 100) {
          // Root frame isolated world: no match
          return Promise.resolve({ result: { type: 'object', subtype: 'null', value: null } });
        }
        if (method === 'Runtime.evaluate' && params?.contextId === 200 && !params.returnByValue) {
          // Child frame: found!
          return Promise.resolve({ result: { objectId: 'child-obj-1' } });
        }
        if (method === 'Runtime.evaluate' && params?.contextId === 200 && params.returnByValue) {
          // Post-action verification in child frame
          return Promise.resolve({ result: { value: { verified: true, count: 1 } } });
        }
        if (method === 'DOM.describeNode') return Promise.resolve({ node: { backendNodeId: 77 } });
        if (method === 'DOM.setFileInputFiles') return Promise.resolve({});
        return Promise.resolve({});
      });

      const result = await onInteract(ctx, {
        actions: [{ type: 'file_upload', selector: 'input[type=file]', files: ['/tmp/a.pdf'] }],
      }, {});

      expect(ctx.cdp).toHaveBeenCalledWith('Page.getFrameTree', expect.anything());
      expect(ctx.cdp).toHaveBeenCalledWith('Page.createIsolatedWorld', expect.objectContaining({ frameId: 'child-frame-1' }));
      expect(ctx.cdp).toHaveBeenCalledWith('DOM.setFileInputFiles', expect.objectContaining({ backendNodeId: 77 }));
      expect(result.content[0].text).toContain('✓ file_upload');
      expect(result.content[0].text).toContain('Uploaded 1 file(s)');
    });

    it('throws clear error when element is not in any frame', async () => {
      (ctx.cdp as any).mockImplementation((method: string, params?: any) => {
        if (method === 'Runtime.evaluate' && !params?.contextId) {
          return Promise.resolve({ result: { type: 'object', subtype: 'null', value: null } });
        }
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({
            frameTree: {
              frame: { id: 'root-frame', url: 'https://example.com' },
              childFrames: [
                { frame: { id: 'child-a', url: 'https://a.example.com' } },
                {
                  frame: { id: 'child-b', url: 'https://b.example.com' },
                  childFrames: [{ frame: { id: 'grandchild', url: 'https://gc.example.com' } }],
                },
              ],
            },
          });
        }
        if (method === 'Page.createIsolatedWorld') {
          return Promise.resolve({ executionContextId: 999 });
        }
        if (method === 'Runtime.evaluate' && params?.contextId) {
          return Promise.resolve({ result: { type: 'object', subtype: 'null', value: null } });
        }
        return Promise.resolve({});
      });

      const result = await onInteract(ctx, {
        actions: [{ type: 'file_upload', selector: 'input[type=file]', files: ['/tmp/a.pdf'] }],
      }, {});

      expect(result.content[0].text).toContain('✗ file_upload');
      expect(result.content[0].text).toContain('Element not found in any frame');
    });

    it('post-action read-back queries the correct child frame context', async () => {
      const evalCalls: any[] = [];
      (ctx.cdp as any).mockImplementation((method: string, params?: any) => {
        if (method === 'Runtime.evaluate') evalCalls.push(params);
        if (method === 'Runtime.evaluate' && !params?.contextId) {
          return Promise.resolve({ result: { type: 'object', subtype: 'null', value: null } });
        }
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({
            frameTree: {
              frame: { id: 'root', url: 'https://example.com' },
              childFrames: [{ frame: { id: 'iframe-42', url: 'https://x.example.com' } }],
            },
          });
        }
        if (method === 'Page.createIsolatedWorld' && params?.frameId === 'root') {
          return Promise.resolve({ executionContextId: 11 });
        }
        if (method === 'Page.createIsolatedWorld' && params?.frameId === 'iframe-42') {
          return Promise.resolve({ executionContextId: 42 });
        }
        if (method === 'Runtime.evaluate' && params?.contextId === 11) {
          return Promise.resolve({ result: { type: 'object', subtype: 'null', value: null } });
        }
        if (method === 'Runtime.evaluate' && params?.contextId === 42 && !params.returnByValue) {
          return Promise.resolve({ result: { objectId: 'file-input-obj' } });
        }
        if (method === 'Runtime.evaluate' && params?.contextId === 42 && params.returnByValue) {
          return Promise.resolve({ result: { value: { verified: true, count: 1 } } });
        }
        if (method === 'DOM.describeNode') return Promise.resolve({ node: { backendNodeId: 55 } });
        if (method === 'DOM.setFileInputFiles') return Promise.resolve({});
        return Promise.resolve({});
      });

      const result = await onInteract(ctx, {
        actions: [{ type: 'file_upload', selector: 'input[type=file]', files: ['/tmp/a.pdf'] }],
      }, {});

      // Verification call must have been issued with contextId=42 and returnByValue
      const verificationCall = evalCalls.find((c) => c?.contextId === 42 && c?.returnByValue);
      expect(verificationCall).toBeDefined();
      expect(result.content[0].text).toContain('✓ file_upload');
    });
  });
});
