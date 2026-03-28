import { describe, it, expect } from 'vitest';
import { getTip } from '../src/tips';

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

  // Only one tip per call (highest priority wins)
  it('returns highest priority tip when multiple match', () => {
    const tip = getTip('browser_evaluate', {
      expression: `const btns = document.querySelectorAll('button'); btns[0].click();`
    }, 'ok');
    expect(tip).toContain('browser_interact');
    expect(tip).not.toContain('browser_lookup');
  });
});
