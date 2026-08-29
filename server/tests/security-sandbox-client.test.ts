import { describe, it, expect } from 'vitest';
import { buildClient } from '../src/security/sandbox/client';
import { METHODS, PERMISSION_GATED, buildParams } from '../src/security/sandbox/methods';

/** Record every command the client sends and reply with a canned result. */
function recorder(reply: unknown = { ok: 1 }) {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const send = async (method: string, params: Record<string, unknown>) => {
    sent.push({ method, params });
    return typeof reply === 'function' ? (reply as any)(method, params) : reply;
  };
  return { sent, send };
}

describe('buildParams', () => {
  it('names arguments after the declared parameters', () => {
    expect(buildParams({ params: ['selector', 'text'] }, ['#q', 'hi'])).toEqual({ selector: '#q', text: 'hi' });
  });

  it('omits an absent optional argument entirely — no null placeholder', () => {
    const out = buildParams({ params: ['x', 'y', 'opts'] }, [10, 20]);
    expect(out).toEqual({ x: 10, y: 20 });
    expect('opts' in out).toBe(false);
  });

  it('drops extra arguments beyond the declared list', () => {
    expect(buildParams({ params: ['url'] }, ['a', 'b'])).toEqual({ url: 'a' });
  });

  it('returns an empty object for a no-arg method', () => {
    expect(buildParams({ params: [] }, [])).toEqual({});
  });
});

describe('buildClient — wire shape', () => {
  it('sends click(selector) as { selector }', async () => {
    const { sent, send } = recorder();
    await buildClient(send).click('#go');
    expect(sent).toEqual([{ method: 'click', params: { selector: '#go' } }]);
  });

  it('sends type(selector, text) as { selector, text }', async () => {
    const { sent, send } = recorder();
    await buildClient(send).type('#q', 'hello');
    expect(sent[0]).toEqual({ method: 'type', params: { selector: '#q', text: 'hello' } });
  });

  it('sends mouseClick(x, y) without an opts key', async () => {
    const { sent, send } = recorder();
    await buildClient(send).mouseClick(10, 20);
    expect(sent[0].params).toEqual({ x: 10, y: 20 });
  });

  it('sends the union-typed wait under its declared parameter name', async () => {
    const { sent, send } = recorder();
    const c = buildClient(send);
    await c.wait(1500);
    await c.wait('#ready');
    expect(sent.map(s => s.params)).toEqual([{ msOrSelector: 1500 }, { msOrSelector: '#ready' }]);
  });

  it('sends snapshot() as {}', async () => {
    const { sent, send } = recorder();
    await buildClient(send).snapshot();
    expect(sent[0]).toEqual({ method: 'snapshot', params: {} });
  });

  it('nests dotted paths into namespace objects', async () => {
    const { sent, send } = recorder();
    const c = buildClient(send);
    await c.tabs.list();
    await c.storage.set({ key: 'k', value: 'v' });
    await c.window.maximize();
    expect(sent.map(s => s.method)).toEqual(['tabs.list', 'storage.set', 'window.maximize']);
    expect(sent[1].params).toEqual({ opts: { key: 'k', value: 'v' } });
  });

  it('builds every non-gated method in the table', () => {
    const c = buildClient(async () => ({}));
    for (const path of Object.keys(METHODS)) {
      if (PERMISSION_GATED[path]) continue;
      const fn = path.split('.').reduce<any>((o, seg) => o?.[seg], c);
      expect(typeof fn, `${path} should be a function`).toBe('function');
    }
  });
});

describe('buildClient — permission by construction', () => {
  it('does NOT build evaluate when the eval permission is absent', () => {
    const c = buildClient(async () => ({}));
    expect(c.evaluate).toBeUndefined();
    expect('evaluate' in c).toBe(false);
  });

  it('does NOT build evaluate for an unrelated permission', () => {
    expect(buildClient(async () => ({}), ['something_else']).evaluate).toBeUndefined();
  });

  it('builds evaluate when the eval permission is declared', async () => {
    const { sent, send } = recorder();
    await buildClient(send, ['eval']).evaluate('1 + 1');
    expect(sent[0]).toEqual({ method: 'evaluate', params: { code: '1 + 1' } });
  });
});

describe('buildClient — result handling', () => {
  it('returns the raw result untouched for data methods', async () => {
    const payload = { rows: [1, 2, 3] };
    const c = buildClient(async () => payload);
    expect(await c.snapshot()).toBe(payload);
  });

  it('coerces see* to a boolean from { visible }', async () => {
    expect(await buildClient(async () => ({ visible: true, text: 'x' })).seeText('x')).toBe(true);
    expect(await buildClient(async () => ({ visible: false, text: 'x' })).seeText('x')).toBe(false);
    expect(await buildClient(async () => ({ exists: true, visible: false })).seeElement('#a')).toBe(false);
  });

  it('passes a see* result through when it is already a boolean', async () => {
    expect(await buildClient(async () => true).seeText('x')).toBe(true);
    expect(await buildClient(async () => false).seeText('x')).toBe(false);
  });

  it('never throws on a false see* result', async () => {
    await expect(buildClient(async () => ({ visible: false })).seeElement('#a')).resolves.toBe(false);
  });

  it('THROWS on the { success: false, error } failure envelope', async () => {
    const c = buildClient(async () => ({ success: false, error: 'Element not found: #go' }));
    await expect(c.click('#go')).rejects.toThrow('Element not found: #go');
  });

  it('propagates a rejected send', async () => {
    const c = buildClient(async () => { throw new Error('pipe closed'); });
    await expect(c.click('#go')).rejects.toThrow('pipe closed');
  });
});
