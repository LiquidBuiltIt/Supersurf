import { describe, it, expect } from 'vitest';
import {
  classifyToolFailure,
  selectorOf,
  PlaybookCommandError,
} from '../src/playbooks/errors';

describe('selectorOf()', () => {
  it('reads a top-level selector', () => {
    expect(selectorOf({ selector: '#go' })).toBe('#go');
  });

  it('reads the selector out of a browser_interact action batch', () => {
    expect(selectorOf({ actions: [{ type: 'click', selector: '.job' }] })).toBe('.job');
  });

  it('reads the first field selector out of a fill_form batch', () => {
    expect(selectorOf({ fields: [{ selector: '#email', value: 'a' }] })).toBe('#email');
  });

  it('returns undefined when there is no selector anywhere', () => {
    expect(selectorOf({ url: 'https://example.com' })).toBeUndefined();
  });
});

describe('classifyToolFailure()', () => {
  it('classifies a missing element as SelectorMiss and keeps the selector', () => {
    const out = classifyToolFailure(
      'browser_interact',
      { actions: [{ type: 'click', selector: '.Layout-sidebar' }] },
      '✗ click: Element not found: `.Layout-sidebar`',
    );
    expect(out.type).toBe('SelectorMiss');
    expect(out.payload.selector).toBe('.Layout-sidebar');
  });

  it('classifies a wait-for-element expiry as SelectorMiss, not Timeout', () => {
    const out = classifyToolFailure(
      'browser_interact',
      { actions: [{ type: 'wait', selector: '#done' }] },
      'Timeout waiting for element: #done',
    );
    expect(out.type).toBe('SelectorMiss');
  });

  it('classifies a focus failure as SelectorMiss', () => {
    const out = classifyToolFailure(
      'browser_interact', { actions: [{ type: 'type', selector: '#q' }] }, 'Failed to focus #q',
    );
    expect(out.type).toBe('SelectorMiss');
  });

  it('classifies a zero-match extract as SelectorMiss', () => {
    const out = classifyToolFailure(
      'browser_extract_content', { mode: 'selector', selector: '.gone' }, 'No content element found',
    );
    expect(out.type).toBe('SelectorMiss');
    expect(out.payload.selector).toBe('.gone');
  });

  it('classifies a Chrome error interstitial as PageUnavailable and keeps the URL', () => {
    const out = classifyToolFailure(
      'browser_navigate',
      { action: 'url', url: 'https://nope.invalid' },
      'Navigation succeeded but the page did not load — Chrome displayed an error interstitial (likely network failure, DNS error, or the request was blocked).',
    );
    expect(out.type).toBe('PageUnavailable');
    expect(out.payload.requestedUrl).toBe('https://nope.invalid');
  });

  it('classifies a dead extension as HarnessUnavailable', () => {
    const out = classifyToolFailure('browser_snapshot', {}, 'Extension not connected.\n\nThe extension typically auto-connects…');
    expect(out.type).toBe('HarnessUnavailable');
    expect(out.payload.component).toBe('extension');
  });

  it('classifies a secure_eval block as Refused', () => {
    const out = classifyToolFailure(
      'browser_evaluate', { function: '() => fetch("/x")' }, 'Code blocked by `secure_eval`.\n\n**Reason:** network access',
    );
    expect(out.type).toBe('Refused');
    expect(out.payload.reason).toBe('secure_eval');
  });

  it('classifies a withheld playbook method as Refused', () => {
    const out = classifyToolFailure('', {}, '`connect` is not available to playbook scripts.');
    expect(out.type).toBe('Refused');
  });

  it('falls back to Refused — never SelectorMiss — for an unrecognised tool failure', () => {
    const out = classifyToolFailure('browser_pdf_save', {}, 'something odd happened');
    expect(out.type).toBe('Refused');
    expect(out.payload.reason).toBe('tool-error');
    expect(out.payload.detail).toBe('browser_pdf_save');
  });
});

describe('PlaybookCommandError', () => {
  it('carries its type and payload alongside the message', () => {
    const e = new PlaybookCommandError('boom', 'SelectorMiss', { selector: '#x' });
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('boom');
    expect(e.playbookType).toBe('SelectorMiss');
    expect(e.playbookPayload).toEqual({ selector: '#x' });
  });
});
