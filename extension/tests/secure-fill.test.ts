import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockChrome } from './__mocks__/chrome';
import { secureFill, runSecureFill } from '../src/secure-fill.js';

// No jsdom available: run under node with a minimal fake element/document.
class FakeKeyboardEvent extends Event {
  key: string;
  constructor(type: string, init: { key: string; bubbles?: boolean }) {
    super(type, init);
    this.key = init.key;
  }
}

class FakeElement extends EventTarget {
  value = '';
  log: string[] = [];
  constructor() {
    super();
    for (const t of ['focus', 'input', 'change', 'keydown', 'keyup']) {
      this.addEventListener(t, (e) => {
        const key = (e as any).key;
        this.log.push(key !== undefined ? `${t} ${key}` : t);
      });
    }
  }
  focus() {
    // real focus() fires a focus event; the module also dispatches one, so log only the dispatch
  }
}

let el: FakeElement;

beforeEach(() => {
  vi.useFakeTimers();
  el = new FakeElement();
  vi.stubGlobal('KeyboardEvent', FakeKeyboardEvent);
  vi.stubGlobal('document', { querySelector: (s: string) => (s === '#pw' ? el : null) });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('secureFill', () => {
  it('sets the value and reports success', async () => {
    const p = secureFill('#pw', 'abc');
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ success: true });
    expect(el.value).toBe('abc');
  });

  it('dispatches events in order', async () => {
    const p = secureFill('#pw', 'ab');
    await vi.runAllTimersAsync();
    await p;
    expect(el.log).toEqual([
      'focus', 'input',
      'keydown a', 'input', 'keyup a',
      'keydown b', 'input', 'keyup b',
      'change',
    ]);
  });

  it('returns an error for a missing element', async () => {
    expect(await secureFill('#nope', 'x')).toEqual({ success: false, error: 'Element not found: #nope' });
  });

  it('waits at least 40ms and under 120ms before each key', async () => {
    const keydowns = () => el.log.filter((l) => l.startsWith('keydown')).length;

    vi.spyOn(Math, 'random').mockReturnValue(0);
    const p1 = secureFill('#pw', 'a');
    await vi.advanceTimersByTimeAsync(39);
    expect(keydowns()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(keydowns()).toBe(1);
    await p1;

    el.log = [];
    vi.spyOn(Math, 'random').mockReturnValue(0.9999999);
    const p2 = secureFill('#pw', 'a');
    // 40 + 0.9999999 * 80 = 119.99999ms; timers truncate to whole ms, so it fires at 119.
    await vi.advanceTimersByTimeAsync(118);
    expect(keydowns()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(keydowns()).toBe(1);
    await p2;
  });

  it('types a surrogate pair as one key', async () => {
    const p = secureFill('#pw', 'p🔑x');
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ success: true });
    const keys = el.log.filter((l) => l.startsWith('keydown')).map((l) => l.slice(8));
    expect(keys).toEqual(['p', '🔑', 'x']);
    expect(el.value).toBe('p🔑x');
  });

  it('returns the error message when the page throws', async () => {
    el.focus = () => {
      throw new Error('boom');
    };
    expect(await secureFill('#pw', 'x')).toEqual({ success: false, error: 'boom' });
  });
});

describe('runSecureFill', () => {
  let mockChrome: ReturnType<typeof createMockChrome>;

  beforeEach(() => {
    mockChrome = createMockChrome();
    (globalThis as any).chrome = mockChrome;
  });

  it('runs secureFill itself in the MAIN world and returns its result', async () => {
    mockChrome.scripting.executeScript.mockResolvedValueOnce([{ result: { success: true } }]);
    const res = await runSecureFill(7, '#pw', 'v');
    expect(mockChrome.scripting.executeScript).toHaveBeenCalledTimes(1);
    const arg = (mockChrome.scripting.executeScript.mock.calls[0] as any[])[0];
    expect(arg.target).toEqual({ tabId: 7 });
    expect(arg.world).toBe('MAIN');
    expect(arg.func).toBe(secureFill);
    expect(arg.args).toEqual(['#pw', 'v']);
    expect(res).toEqual({ success: true });
  });

  it.each([[[]], [[{ result: undefined }]]])('falls back when the script yields no result (%j)', async (ret) => {
    mockChrome.scripting.executeScript.mockResolvedValueOnce(ret as any);
    expect(await runSecureFill(7, '#pw', 'v')).toEqual({ success: false, error: 'Script execution failed' });
  });
});
