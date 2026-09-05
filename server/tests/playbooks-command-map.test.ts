import { describe, it, expect } from 'vitest';
import { mapCommand, KNOWN_METHODS } from '../src/playbooks/command-map';
import { PlaybookCommandError } from '../src/playbooks/errors';

describe('mapCommand — navigation', () => {
  it('maps goto/back/forward/reload onto browser_navigate', () => {
    expect(mapCommand('goto', { url: 'https://x.com' }))
      .toEqual({ tool: 'browser_navigate', args: { action: 'url', url: 'https://x.com' } });
    expect(mapCommand('back', {})).toEqual({ tool: 'browser_navigate', args: { action: 'back' } });
    expect(mapCommand('forward', {})).toEqual({ tool: 'browser_navigate', args: { action: 'forward' } });
    expect(mapCommand('reload', {})).toEqual({ tool: 'browser_navigate', args: { action: 'reload' } });
  });
});

describe('mapCommand — interaction', () => {
  it('wraps each verb in a single-element browser_interact actions array', () => {
    expect(mapCommand('click', { selector: '#go' }))
      .toEqual({ tool: 'browser_interact', args: { actions: [{ type: 'click', selector: '#go' }] } });
    expect(mapCommand('type', { selector: '#q', text: 'hi' }))
      .toEqual({ tool: 'browser_interact', args: { actions: [{ type: 'type', selector: '#q', text: 'hi' }] } });
    expect(mapCommand('pressKey', { key: 'Enter' }))
      .toEqual({ tool: 'browser_interact', args: { actions: [{ type: 'press_key', key: 'Enter' }] } });
    expect(mapCommand('upload', { selector: '#f', files: ['/tmp/a'] }))
      .toEqual({ tool: 'browser_interact', args: { actions: [{ type: 'file_upload', selector: '#f', files: ['/tmp/a'] }] } });
    expect(mapCommand('forcePseudoState', { selector: '#b', states: ['hover'] }))
      .toEqual({ tool: 'browser_interact', args: { actions: [{ type: 'force_pseudo_state', selector: '#b', pseudoStates: ['hover'] }] } });
  });

  it('routes wait by argument type — number is a delay, string is a selector', () => {
    expect(mapCommand('wait', { msOrSelector: 1500 }))
      .toEqual({ tool: 'browser_interact', args: { actions: [{ type: 'wait', timeout: 1500 }] } });
    expect(mapCommand('wait', { msOrSelector: '#done' }))
      .toEqual({ tool: 'browser_interact', args: { actions: [{ type: 'wait', selector: '#done' }] } });
  });

  it('passes optional mouseClick options through', () => {
    expect(mapCommand('mouseClick', { x: 10, y: 20, button: 'right', clickCount: 2 }))
      .toEqual({ tool: 'browser_interact', args: { actions: [{ type: 'mouse_click', x: 10, y: 20, button: 'right', clickCount: 2 }] } });
    expect(mapCommand('mouseClick', { x: 10, y: 20 }))
      .toEqual({ tool: 'browser_interact', args: { actions: [{ type: 'mouse_click', x: 10, y: 20 }] } });
  });
});

describe('mapCommand — content, verification, forms', () => {
  it('maps the content readers', () => {
    expect(mapCommand('snapshot', {})).toEqual({ tool: 'browser_snapshot', args: {} });
    expect(mapCommand('lookup', { query: 'Sign in' })).toEqual({ tool: 'browser_lookup', args: { text: 'Sign in' } });
    expect(mapCommand('extract', { mode: 'selector', selector: 'main' }))
      .toEqual({ tool: 'browser_extract_content', args: { mode: 'selector', selector: 'main' } });
    expect(mapCommand('extract', {})).toEqual({ tool: 'browser_extract_content', args: {} });
    expect(mapCommand('styles', { selector: '#a', properties: ['color'] }))
      .toEqual({ tool: 'browser_get_element_styles', args: { selector: '#a', properties: ['color'] } });
    expect(mapCommand('screenshot', { fullPage: true }))
      .toEqual({ tool: 'browser_take_screenshot', args: { fullPage: true } });
  });

  it('maps the boolean verifiers', () => {
    expect(mapCommand('seeText', { text: 'Unread' }))
      .toEqual({ tool: 'browser_verify_text_visible', args: { text: 'Unread' } });
    expect(mapCommand('seeElement', { selector: '#x' }))
      .toEqual({ tool: 'browser_verify_element_visible', args: { selector: '#x' } });
  });

  it('maps the form helpers onto the real tool parameter names', () => {
    // §7.7 locks the client signature `fill(fields: Record<string, string>)`, but
    // browser_fill_form takes an ARRAY of {selector, value}. Bridging the two is
    // exactly what this map is for.
    expect(mapCommand('fill', { fields: { '#a': '1', '#b': '2' } }))
      .toEqual({ tool: 'browser_fill_form', args: { fields: [{ selector: '#a', value: '1' }, { selector: '#b', value: '2' }] } });
    // browser_drag's schema names are fromSelector/toSelector.
    expect(mapCommand('drag', { from: '#a', to: '#b' }))
      .toEqual({ tool: 'browser_drag', args: { fromSelector: '#a', toSelector: '#b' } });
    // secure_fill's schema name is credential_env.
    expect(mapCommand('secureFill', { selector: '#pw', envName: 'X_PASSWORD' }))
      .toEqual({ tool: 'secure_fill', args: { action: 'fill', selector: '#pw', credential_env: 'X_PASSWORD' } });
  });

  it('passes an already-array fields value through untouched', () => {
    expect(mapCommand('fill', { fields: [{ selector: '#a', value: '1' }] }))
      .toEqual({ tool: 'browser_fill_form', args: { fields: [{ selector: '#a', value: '1' }] } });
  });
});

describe('mapCommand — namespaced passthroughs', () => {
  it('unpacks the action enum from the method name', () => {
    expect(mapCommand('tabs.new', { url: 'https://a' })).toEqual({ tool: 'browser_tabs', args: { action: 'new', url: 'https://a' } });
    expect(mapCommand('tabs.list', {})).toEqual({ tool: 'browser_tabs', args: { action: 'list' } });
    expect(mapCommand('window.resize', { width: 800, height: 600 }))
      .toEqual({ tool: 'browser_window', args: { action: 'resize', width: 800, height: 600 } });
    expect(mapCommand('dialog.accept', {})).toEqual({ tool: 'browser_handle_dialog', args: { action: 'accept' } });
    expect(mapCommand('storage.get', { type: 'localStorage', key: 'k' }))
      .toEqual({ tool: 'browser_storage', args: { action: 'get', type: 'localStorage', key: 'k' } });
    expect(mapCommand('net.requests', { limit: 5 })).toEqual({ tool: 'browser_network_requests', args: { limit: 5 } });
    expect(mapCommand('net.console', {})).toEqual({ tool: 'browser_console_messages', args: {} });
    expect(mapCommand('pdf', { path: '/tmp/a.pdf' })).toEqual({ tool: 'browser_pdf_save', args: { path: '/tmp/a.pdf' } });
    expect(mapCommand('perf', {})).toEqual({ tool: 'browser_performance_metrics', args: {} });
    expect(mapCommand('extensions', {})).toEqual({ tool: 'browser_list_extensions', args: {} });
  });

  it('unwraps the single `opts` key the client packs namespaced params into', () => {
    expect(mapCommand('tabs.new', { opts: { url: 'https://a' } }))
      .toEqual({ tool: 'browser_tabs', args: { action: 'new', url: 'https://a' } });
    expect(mapCommand('net.requests', { opts: { limit: 5 } }))
      .toEqual({ tool: 'browser_network_requests', args: { limit: 5 } });
  });
});

describe('mapCommand — refusals', () => {
  it('throws on an unmapped method', () => {
    expect(() => mapCommand('teleport', {})).toThrow(/Unknown playbook command/);
  });

  it('refuses the deliberately absent methods by name', () => {
    for (const m of ['connect', 'disconnect', 'profile_create', 'playbook']) {
      expect(() => mapCommand(m, {})).toThrow(/not available to playbook scripts/);
    }
  });

  // `mapCommand` runs BEFORE `unwrapTyped` in the runner's `onCommand`, so a
  // plain Error here never reaches `classifyToolFailure` — it just escapes as
  // an untyped throw and the taxonomy reports the wrong thing. The refusal has
  // to carry its own type.
  it('refuses with a Refused-typed PlaybookCommandError, not a plain Error', () => {
    for (const [method, reason] of [['connect', 'withheld-method'], ['teleport', 'unknown-method']]) {
      let caught: any;
      try { mapCommand(method, {}); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(PlaybookCommandError);
      expect(caught.playbookType).toBe('Refused');
      expect(caught.playbookPayload).toMatchObject({ reason, method });
    }
  });

  it('maps evaluate — the permission gate is the client object, not this map', () => {
    expect(mapCommand('evaluate', { code: '1+1' }, 'post_tweet'))
      .toEqual({ tool: 'browser_evaluate', args: { function: '1+1', purpose: 'playbook:post_tweet' } });
  });

  it('supplies a non-empty purpose even with no playbook name', () => {
    // tools/browser_evaluate/index.ts hard-rejects an empty purpose.
    const { args } = mapCommand('evaluate', { code: '1+1' });
    expect(args.purpose).toBe('playbook:unnamed');
    expect(String(args.purpose).length).toBeGreaterThan(0);
    expect(args).not.toHaveProperty('code');
  });

  it('KNOWN_METHODS covers every mapped name', () => {
    expect(KNOWN_METHODS).toContain('click');
    expect(KNOWN_METHODS).toContain('tabs.new');
    expect(KNOWN_METHODS).not.toContain('connect');
  });
});
