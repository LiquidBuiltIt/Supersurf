import { describe, it, expect, beforeEach } from 'vitest';
import { getTip, clearTipCounters } from '../src/tips';
import { actionTrail } from '../src/playbooks/trail';
import { experimentRegistry } from '../src/experimental/index';

// The playbooks tips read actionTrail.size()/tail() and experimentRegistry's
// fingerprinting flag. Both are module-level singletons — reset before every
// test so trail growth / gate state from one test can't leak into another.
beforeEach(() => {
  actionTrail._resetForTest();
  experimentRegistry.reset();
});

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

  // Tip 11: screenshot tool suggests inline screenshot
  it('returns inline screenshot tip on browser_take_screenshot', () => {
    const tip = getTip('browser_take_screenshot', {}, 'ok');
    expect(tip).toContain('screenshot: true');
    expect(tip).toContain('browser_interact');
  });

  // Tip 12: evaluate reading innerHTML/outerHTML
  it('returns extract_content tip when evaluate reads innerHTML', () => {
    const tip = getTip('browser_evaluate', {
      expression: `document.querySelector('.article').innerHTML`
    }, 'ok');
    expect(tip).toContain('browser_extract_content');
  });

  it('returns extract_content tip when evaluate reads outerHTML', () => {
    const tip = getTip('browser_evaluate', {
      expression: `document.querySelector('table').outerHTML`
    }, 'ok');
    expect(tip).toContain('browser_extract_content');
  });

  // Tip 13: evaluate doing getBoundingClientRect for position
  it('returns lookup tip when evaluate does getBoundingClientRect', () => {
    const tip = getTip('browser_evaluate', {
      expression: `document.querySelector('button').getBoundingClientRect()`
    }, 'ok');
    expect(tip).toContain('browser_lookup');
    expect(tip).toContain('coordinates');
  });

  it('does not return position tip when getBoundingClientRect is part of click', () => {
    const tip = getTip('browser_evaluate', {
      expression: `const el = document.querySelector('button'); const r = el.getBoundingClientRect(); el.click();`
    }, 'ok');
    // Should get the click tip, not the position tip
    expect(tip).toContain('browser_interact');
    expect(tip).not.toContain('coordinates');
  });

  // Tip 14: evaluate reading getComputedStyle
  it('returns styles tip when evaluate does getComputedStyle', () => {
    const tip = getTip('browser_evaluate', {
      expression: `window.getComputedStyle(document.querySelector('.btn')).color`
    }, 'ok');
    expect(tip).toContain('browser_get_element_styles');
  });

  // Only one tip per call (highest priority wins)
  it('returns highest priority tip when multiple match', () => {
    const tip = getTip('browser_evaluate', {
      expression: `const btns = document.querySelectorAll('button'); btns[0].click();`
    }, 'ok');
    expect(tip).toContain('browser_interact');
    expect(tip).not.toContain('browser_lookup');
  });
});

describe('getTip session suppression', () => {
  const queryEval = { expression: `document.querySelector('h1').textContent` };
  const clickEval = { expression: `document.querySelector('button').click()` };

  it('omits suppression when no sessionId given (pure-function mode)', () => {
    // Without sessionId, tip always returns regardless of prior calls
    for (let i = 0; i < 10; i++) {
      const tip = getTip('browser_evaluate', queryEval, 'ok');
      expect(tip).toBeTruthy();
    }
  });

  it('shows tip for first 3 consecutive triggers then suppresses on 4th', () => {
    const sid = 'sess-suppress-basic';
    clearTipCounters(sid);
    expect(getTip('browser_evaluate', queryEval, 'ok', undefined, sid)).toContain('browser_lookup');
    expect(getTip('browser_evaluate', queryEval, 'ok', undefined, sid)).toContain('browser_lookup');
    expect(getTip('browser_evaluate', queryEval, 'ok', undefined, sid)).toContain('browser_lookup');
    // 4th consecutive trigger: suppressed
    expect(getTip('browser_evaluate', queryEval, 'ok', undefined, sid)).toBeNull();
    // 5th still suppressed
    expect(getTip('browser_evaluate', queryEval, 'ok', undefined, sid)).toBeNull();
    clearTipCounters(sid);
  });

  it('resets counter when the same tool is called without this tip matching', () => {
    const sid = 'sess-suppress-reset';
    clearTipCounters(sid);
    // Trigger lookup tip 3x -> suppressed on 4th
    getTip('browser_evaluate', queryEval, 'ok', undefined, sid);
    getTip('browser_evaluate', queryEval, 'ok', undefined, sid);
    getTip('browser_evaluate', queryEval, 'ok', undefined, sid);
    expect(getTip('browser_evaluate', queryEval, 'ok', undefined, sid)).toBeNull();
    // Call evaluate with code that doesn't match the lookup tip (plain math)
    getTip('browser_evaluate', { expression: '1+1' }, 'ok', undefined, sid);
    // Next matching call should fire again
    expect(getTip('browser_evaluate', queryEval, 'ok', undefined, sid)).toContain('browser_lookup');
    clearTipCounters(sid);
  });

  it('tracks tips independently — click tip counter does not affect lookup tip counter', () => {
    const sid = 'sess-suppress-indep';
    clearTipCounters(sid);
    // Fire click tip 3x
    getTip('browser_evaluate', clickEval, 'ok', undefined, sid);
    getTip('browser_evaluate', clickEval, 'ok', undefined, sid);
    getTip('browser_evaluate', clickEval, 'ok', undefined, sid);
    // Click tip should be suppressed on the 4th
    expect(getTip('browser_evaluate', clickEval, 'ok', undefined, sid)).toBeNull();
    // Lookup tip should still fire (its counter is untouched)
    expect(getTip('browser_evaluate', queryEval, 'ok', undefined, sid)).toContain('browser_lookup');
    clearTipCounters(sid);
  });

  it('isolates state per session', () => {
    const a = 'sess-A';
    const b = 'sess-B';
    clearTipCounters(a);
    clearTipCounters(b);
    // Saturate session A
    getTip('browser_evaluate', queryEval, 'ok', undefined, a);
    getTip('browser_evaluate', queryEval, 'ok', undefined, a);
    getTip('browser_evaluate', queryEval, 'ok', undefined, a);
    expect(getTip('browser_evaluate', queryEval, 'ok', undefined, a)).toBeNull();
    // Session B still sees the tip
    expect(getTip('browser_evaluate', queryEval, 'ok', undefined, b)).toContain('browser_lookup');
    clearTipCounters(a);
    clearTipCounters(b);
  });

  it('clearTipCounters() resets a session', () => {
    const sid = 'sess-clear';
    clearTipCounters(sid);
    getTip('browser_evaluate', queryEval, 'ok', undefined, sid);
    getTip('browser_evaluate', queryEval, 'ok', undefined, sid);
    getTip('browser_evaluate', queryEval, 'ok', undefined, sid);
    expect(getTip('browser_evaluate', queryEval, 'ok', undefined, sid)).toBeNull();
    clearTipCounters(sid);
    expect(getTip('browser_evaluate', queryEval, 'ok', undefined, sid)).toContain('browser_lookup');
    clearTipCounters(sid);
  });
});

describe('getTip — playbooks-milestone tip', () => {
  function recordCalls(n: number) {
    for (let i = 0; i < n; i++) {
      actionTrail.record({ tool: 'browser_tabs', type: 'browser_tabs', outcome: 'ok', message: 'ok', params: {} });
    }
  }

  it('does not fire before the trail reaches 8 entries', () => {
    experimentRegistry.enable('fingerprinting');
    recordCalls(7);
    expect(getTip('browser_tabs', { action: 'list' }, 'ok', undefined, 'sess-milestone-early')).toBeNull();
  });

  it('fires once when the trail reaches 8 entries, then stays silent', () => {
    const sid = 'sess-milestone-once';
    experimentRegistry.enable('fingerprinting');
    recordCalls(8);
    const tip = getTip('browser_tabs', { action: 'list' }, 'ok', undefined, sid);
    expect(tip).toContain('8 actions recorded this session');
    expect(tip).toContain('playbooks create');

    // Trail state still qualifies, but the tip already fired this session.
    expect(getTip('browser_tabs', { action: 'list' }, 'ok', undefined, sid)).toBeNull();
  });

  it('shows the gate-off message when the fingerprinting experiment is disabled', () => {
    recordCalls(8);
    const tip = getTip('browser_tabs', { action: 'list' }, 'ok', undefined, 'sess-milestone-gate-off');
    expect(tip).toContain('Enable the `fingerprinting` experiment');
    expect(tip).not.toContain('8 actions recorded');
  });

  it('never fires for the playbooks tool itself', () => {
    experimentRegistry.enable('fingerprinting');
    recordCalls(8);
    expect(getTip('playbooks', { action: 'history' }, 'ok', undefined, 'sess-milestone-pb')).toBeNull();
  });

  it('clearTipCounters resets the once-per-session flag', () => {
    const sid = 'sess-clear-milestone';
    experimentRegistry.enable('fingerprinting');
    recordCalls(8);
    expect(getTip('browser_tabs', { action: 'list' }, 'ok', undefined, sid)).toContain('8 actions recorded');
    expect(getTip('browser_tabs', { action: 'list' }, 'ok', undefined, sid)).toBeNull();
    clearTipCounters(sid);
    expect(getTip('browser_tabs', { action: 'list' }, 'ok', undefined, sid)).toContain('8 actions recorded');
  });
});

describe('getTip — playbooks-repeat tip', () => {
  function recordWindow(url: string) {
    actionTrail.record({
      tool: 'browser_navigate', type: 'browser_navigate', outcome: 'ok', message: 'ok',
      params: { action: 'url', url },
    });
    actionTrail.record({
      tool: 'browser_interact', type: 'click', outcome: 'ok', message: 'ok',
      params: { selector: '#btn' }, url,
    });
    actionTrail.record({
      tool: 'browser_evaluate', type: 'browser_evaluate', outcome: 'ok', message: 'ok',
      params: { expression: '1+1' }, url,
    });
  }

  it('fires on a repeated 3-entry window spanning >= 2 distinct tools', () => {
    experimentRegistry.enable('fingerprinting');
    recordWindow('https://ex.com/a');
    recordWindow('https://ex.com/a');
    const tip = getTip('browser_tabs', { action: 'list' }, 'ok', undefined, 'sess-repeat-basic');
    expect(tip).toContain('repeat an earlier sequence');
    expect(tip).toContain('playbooks create');
  });

  it('does not fire when the repeated window is a single tool (e.g. scroll x3)', () => {
    experimentRegistry.enable('fingerprinting');
    for (let i = 0; i < 6; i++) {
      actionTrail.record({
        tool: 'browser_interact', type: 'scroll_by', outcome: 'ok', message: 'ok',
        params: {}, url: 'https://ex.com',
      });
    }
    expect(getTip('browser_tabs', { action: 'list' }, 'ok', undefined, 'sess-repeat-scroll')).toBeNull();
  });

  it('does not fire when the only matching window overlaps the last window', () => {
    experimentRegistry.enable('fingerprinting');
    const rec = (tool: string, url: string) =>
      actionTrail.record({ tool, type: tool, outcome: 'ok', message: 'ok', params: {}, url });
    // Sequence [C, D, A, B, A, B, A]: the A,B,A pattern at indices [4,5,6] also
    // appears at [2,3,4], but that earlier occurrence overlaps the last window
    // (shares index 4) and must not count as a repeat.
    rec('toolC', 'urlC');
    rec('toolD', 'urlD');
    rec('toolA', 'urlA');
    rec('toolB', 'urlB');
    rec('toolA', 'urlA');
    rec('toolB', 'urlB');
    rec('toolA', 'urlA');
    expect(getTip('browser_tabs', { action: 'list' }, 'ok', undefined, 'sess-repeat-overlap')).toBeNull();
  });

  it('fires once per session, not again on the next matching call', () => {
    const sid = 'sess-repeat-once';
    experimentRegistry.enable('fingerprinting');
    recordWindow('https://ex.com/a');
    recordWindow('https://ex.com/a');
    expect(getTip('browser_tabs', { action: 'list' }, 'ok', undefined, sid)).toContain('repeat an earlier sequence');
    expect(getTip('browser_tabs', { action: 'list' }, 'ok', undefined, sid)).toBeNull();
  });

  it('shows the gate-off message when the fingerprinting experiment is disabled', () => {
    recordWindow('https://ex.com/a');
    recordWindow('https://ex.com/a');
    const tip = getTip('browser_tabs', { action: 'list' }, 'ok', undefined, 'sess-repeat-gate-off');
    expect(tip).toContain('Enable the `fingerprinting` experiment');
  });

  it('never fires for the playbooks tool itself', () => {
    experimentRegistry.enable('fingerprinting');
    recordWindow('https://ex.com/a');
    recordWindow('https://ex.com/a');
    expect(getTip('playbooks', { action: 'history' }, 'ok', undefined, 'sess-repeat-pb')).toBeNull();
  });

  it('clearTipCounters resets the once-per-session flag', () => {
    const sid = 'sess-clear-repeat';
    experimentRegistry.enable('fingerprinting');
    recordWindow('https://ex.com/a');
    recordWindow('https://ex.com/a');
    expect(getTip('browser_tabs', { action: 'list' }, 'ok', undefined, sid)).toContain('repeat an earlier sequence');
    expect(getTip('browser_tabs', { action: 'list' }, 'ok', undefined, sid)).toBeNull();
    clearTipCounters(sid);
    expect(getTip('browser_tabs', { action: 'list' }, 'ok', undefined, sid)).toContain('repeat an earlier sequence');
  });
});

describe('getTip — wildcard tips do not disturb per-tool tips', () => {
  it('leaves the existing browser_evaluate click tip untouched when the trail is empty', () => {
    const tip = getTip('browser_evaluate', {
      expression: `document.querySelector('button').click()`,
    }, 'ok');
    expect(tip).toContain('browser_interact');
    expect(tip).toContain(':has-text(');
  });
});
