import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Mock the experiment registry so we control isEnabled.
vi.mock('../src/experimental/index', async () => {
  const actual = await vi.importActual<typeof import('../src/experimental/index')>('../src/experimental/index');
  return { ...actual, experimentRegistry: { ...actual.experimentRegistry, isEnabled: vi.fn().mockReturnValue(false) } };
});

import { experimentRegistry } from '../src/experimental/index';
import { resolveWithHealing, captureInContext, healInContext } from '../src/experimental/fingerprinting/index';
import { getRecord, putRecord, setBaseDirForTests } from '../src/experimental/fingerprinting/store';
import type { FingerprintRecord } from '../src/experimental/fingerprinting/types';

const mockEnabled = experimentRegistry.isEnabled as ReturnType<typeof vi.fn>;
const TMP = path.join(process.cwd(), '.tmp-fp-int');
setBaseDirForTests(TMP);
const url = () => 'https://ex.com/';

function rec(): FingerprintRecord {
  return { selector: '#go', role: 'button', name: 'Go', text: 'Go', tag: 'button', type: null,
    attrs: {}, classList: [], htmlId: '', ordinal: 0, cx: 5, cy: 5, neighborText: '', landmark: '',
    capturedAt: 1, lastSeenAt: 1, hits: 1 };
}

beforeEach(() => mockEnabled.mockReturnValue(false));
afterEach(() => { vi.clearAllMocks(); fs.rmSync(TMP, { recursive: true, force: true }); });

describe('resolveWithHealing', () => {
  it('OFF: passes through to getElementCenter (resolves)', async () => {
    const evalFn = vi.fn().mockResolvedValue({ x: 1, y: 2 }); // getElementCenter's inner eval returns coords
    const center = await resolveWithHealing(evalFn, '#go', url);
    expect(center).toEqual({ x: 1, y: 2 });
  });

  it('OFF: a miss throws and does NOT heal', async () => {
    const evalFn = vi.fn().mockResolvedValue(null); // element not found
    await expect(resolveWithHealing(evalFn, '#go', url)).rejects.toThrow(/not found/i);
  });

  it('ON + miss + stored fingerprint + high score: heals to stored coords', async () => {
    mockEnabled.mockImplementation((f: string) => f === 'fingerprinting');
    putRecord('ex.com', '/', '#go', rec());
    // first evalFn call = getElementCenter (miss → null); second = scoreExpr (good hit)
    const evalFn = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(JSON.stringify({ cx: 42, cy: 99, score: 0.9, margin: 0.5 }));
    const center = await resolveWithHealing(evalFn, '#go', url);
    expect(center).toEqual({ x: 42, y: 99 });
  });

  it('ON + miss + low margin: escalates (throws), never false-heals', async () => {
    mockEnabled.mockImplementation((f: string) => f === 'fingerprinting');
    putRecord('ex.com', '/', '#go', rec());
    const evalFn = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(JSON.stringify({ cx: 42, cy: 99, score: 0.9, margin: 0.05 })); // margin < 0.10
    await expect(resolveWithHealing(evalFn, '#go', url)).rejects.toThrow(/not found/i);
  });

  it('ON + miss + no stored fingerprint: escalates (throws)', async () => {
    mockEnabled.mockImplementation((f: string) => f === 'fingerprinting');
    const evalFn = vi.fn().mockResolvedValueOnce(null);
    await expect(resolveWithHealing(evalFn, '#missing', url)).rejects.toThrow(/not found/i);
  });
});

describe('resolveWithHealing telemetry (emit)', () => {
  beforeEach(() => mockEnabled.mockImplementation((f: string) => f === 'fingerprinting'));

  it('emits outcome=resolved on a clean resolve', async () => {
    const evalFn = vi.fn().mockResolvedValue({ x: 1, y: 2 });
    const emit = vi.fn();
    await resolveWithHealing(evalFn, '#go', url, emit);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'fingerprint', outcome: 'resolved', selector: '#go', domain: 'ex.com', route: '/', hadRecord: false }),
    );
  });

  it('emits outcome=healed with score+margin on a successful heal', async () => {
    putRecord('ex.com', '/', '#go', rec());
    const evalFn = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(JSON.stringify({ cx: 42, cy: 99, score: 0.9, margin: 0.5 }));
    const emit = vi.fn();
    await resolveWithHealing(evalFn, '#go', url, emit);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'healed', score: 0.9, margin: 0.5, hadRecord: true }),
    );
  });

  it('emits outcome=escalated (hadRecord=true) when the gate fails on low margin', async () => {
    putRecord('ex.com', '/', '#go', rec());
    const evalFn = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(JSON.stringify({ cx: 42, cy: 99, score: 0.9, margin: 0.05 }));
    const emit = vi.fn();
    await expect(resolveWithHealing(evalFn, '#go', url, emit)).rejects.toThrow(/not found/i);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'escalated', score: 0.9, margin: 0.05, hadRecord: true }),
    );
  });

  it('emits outcome=escalated (hadRecord=false) when no fingerprint exists', async () => {
    const evalFn = vi.fn().mockResolvedValueOnce(null);
    const emit = vi.fn();
    await expect(resolveWithHealing(evalFn, '#missing', url, emit)).rejects.toThrow(/not found/i);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'escalated', hadRecord: false }),
    );
  });
});

describe('captureInContext (iframe-bound capture)', () => {
  it('OFF: persists nothing and never evals', async () => {
    const evalFn = vi.fn().mockResolvedValue(JSON.stringify(rec()));
    await captureInContext(evalFn, 'https://ex.com/', '#go');
    expect(evalFn).not.toHaveBeenCalled();
    expect(getRecord('ex.com', '/', '#go')).toBeUndefined();
  });

  it('ON: persists the fingerprint resolved via the frame-bound eval', async () => {
    mockEnabled.mockImplementation((f: string) => f === 'fingerprinting');
    const evalFn = vi.fn().mockResolvedValue(JSON.stringify(rec()));
    await captureInContext(evalFn, 'https://ex.com/login', '#go');
    const got = getRecord('ex.com', '/login', '#go');
    expect(got?.name).toBe('Go');
    expect(got?.selector).toBe('#go');
  });
});

describe('healInContext (iframe-bound heal)', () => {
  it('OFF: returns null and never evals', async () => {
    const evalFn = vi.fn().mockResolvedValue(JSON.stringify({ cx: 1, cy: 2, score: 0.9, margin: 0.5 }));
    const hit = await healInContext(evalFn, 'https://ex.com/', '#go');
    expect(hit).toBeNull();
    expect(evalFn).not.toHaveBeenCalled();
  });

  it('ON + stored record + gate-passing score: returns the hit', async () => {
    mockEnabled.mockImplementation((f: string) => f === 'fingerprinting');
    putRecord('ex.com', '/', '#go', rec());
    const evalFn = vi.fn().mockResolvedValue(JSON.stringify({ cx: 42, cy: 99, score: 0.9, margin: 0.5 }));
    const hit = await healInContext(evalFn, 'https://ex.com/', '#go');
    expect(hit).toEqual({ cx: 42, cy: 99, score: 0.9, margin: 0.5 });
  });

  it('ON + low margin: returns null (never false-heals)', async () => {
    mockEnabled.mockImplementation((f: string) => f === 'fingerprinting');
    putRecord('ex.com', '/', '#go', rec());
    const evalFn = vi.fn().mockResolvedValue(JSON.stringify({ cx: 42, cy: 99, score: 0.9, margin: 0.05 }));
    const hit = await healInContext(evalFn, 'https://ex.com/', '#go');
    expect(hit).toBeNull();
  });

  it('ON + no stored record: returns null', async () => {
    mockEnabled.mockImplementation((f: string) => f === 'fingerprinting');
    const evalFn = vi.fn();
    const hit = await healInContext(evalFn, 'https://ex.com/', '#missing');
    expect(hit).toBeNull();
  });
});
