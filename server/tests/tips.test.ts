import { describe, it, expect } from 'vitest';
import { getTip, clearTipCounters } from '../src/tips';

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
