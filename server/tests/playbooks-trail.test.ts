import { describe, it, expect, beforeEach } from 'vitest';
import { actionTrail } from '../src/playbooks/trail';

describe('ActionTrail', () => {
  beforeEach(() => { actionTrail._resetForTest(); });

  it('mints monotonic ids starting at 1', () => {
    const a = actionTrail.record({ tool: 'browser_interact', type: 'click', outcome: 'ok', message: 'Clicked', params: {} });
    const b = actionTrail.record({ tool: 'browser_interact', type: 'type', outcome: 'ok', message: 'Typed', params: {} });
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  it('never reuses an id even after entries are evicted', () => {
    for (let i = 0; i < 10; i++) {
      actionTrail.record({ tool: 't', type: 'click', outcome: 'ok', message: 'm', params: {} });
    }
    const next = actionTrail.record({ tool: 't', type: 'click', outcome: 'ok', message: 'm', params: {} });
    expect(next).toBe(11);
  });

  it('retrieves a recorded entry by id with its params intact', () => {
    const id = actionTrail.record({
      tool: 'browser_interact', type: 'type', outcome: 'ok', message: 'Typed',
      params: { selector: '#user', value: 'alice' }, url: 'https://x.com/login',
    });
    const entry = actionTrail.get(id);
    expect(entry).toBeDefined();
    expect(entry!.id).toBe(id);
    expect(entry!.type).toBe('type');
    expect(entry!.params).toEqual({ selector: '#user', value: 'alice' });
    expect(entry!.url).toBe('https://x.com/login');
  });

  it('returns undefined for an unknown id', () => {
    expect(actionTrail.get(999)).toBeUndefined();
  });

  it('tail returns the most recent entries with a total count', () => {
    for (let i = 0; i < 100; i++) {
      actionTrail.record({ tool: 't', type: 'click', outcome: 'ok', message: `m${i}`, params: {} });
    }
    const page = actionTrail.tail(10, 0);
    expect(page.total).toBe(100);
    expect(page.entries).toHaveLength(10);
    expect(page.entries[0].id).toBe(91);
    expect(page.entries[9].id).toBe(100);
  });

  it('tail honors offset to page backwards', () => {
    for (let i = 0; i < 100; i++) {
      actionTrail.record({ tool: 't', type: 'click', outcome: 'ok', message: `m${i}`, params: {} });
    }
    const page = actionTrail.tail(10, 10);
    expect(page.entries[0].id).toBe(81);
    expect(page.entries[9].id).toBe(90);
  });

  it('caps retained entries at MAX_ENTRIES and evicts the oldest', () => {
    for (let i = 0; i < 12_000; i++) {
      actionTrail.record({ tool: 't', type: 'click', outcome: 'ok', message: 'm', params: {} });
    }
    expect(actionTrail.size()).toBe(10_000);
    expect(actionTrail.get(1)).toBeUndefined();
    expect(actionTrail.get(2001)).toBeDefined();
    expect(actionTrail.get(12_000)).toBeDefined();
  });

  it('truncates long messages to keep memory bounded', () => {
    const id = actionTrail.record({
      tool: 't', type: 'click', outcome: 'ok', message: 'x'.repeat(500), params: {},
    });
    expect(actionTrail.get(id)!.message.length).toBeLessThanOrEqual(200);
  });
});
