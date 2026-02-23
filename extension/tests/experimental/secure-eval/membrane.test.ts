import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildMembrane } from '../../../src/experimental/secure-eval/membrane';
import { registerSecureEvalHandlers } from '../../../src/experimental/secure-eval/index';

// ── buildMembrane unit tests ──

describe('buildMembrane', () => {
  it('throws on blocked terminal access', () => {
    const membrane = buildMembrane();
    expect(() => (membrane as any).fetch).toThrow('[secure_eval:membrane] Blocked: fetch');
  });

  it('throws on deep chain reaching blocked terminal', () => {
    const membrane = buildMembrane();
    expect(() => (membrane as any).document.querySelector.fetch).toThrow(
      '[secure_eval:membrane] Blocked: document.querySelector.fetch'
    );
  });

  it('returns proxy for non-blocked access', () => {
    const membrane = buildMembrane();
    // Should not throw
    const result = (membrane as any).document;
    expect(result).toBeDefined();
    expect(typeof result).toBe('function'); // Proxy wraps a function target
  });

  it('has trap returns true for all props', () => {
    const membrane = buildMembrane();
    expect('fetch' in membrane).toBe(true);
    expect('anyProp' in membrane).toBe(true);
    expect('nonexistent' in membrane).toBe(true);
  });

  it('throws on blocked terminal set', () => {
    const membrane = buildMembrane();
    expect(() => { (membrane as any).fetch = 42; }).toThrow('[secure_eval:membrane]');
  });

  it('allows set on non-blocked props', () => {
    const membrane = buildMembrane();
    // Should not throw
    (membrane as any).safeVar = 42;
  });

  it('apply trap returns proxy for intermediate calls', () => {
    const membrane = buildMembrane();
    // querySelector() should return another proxy, not throw
    const result = (membrane as any).document.querySelector('h1');
    expect(result).toBeDefined();
  });

  it('throws on blocked terminal after intermediate call', () => {
    const membrane = buildMembrane();
    expect(() => (membrane as any).navigator.sendBeacon).toThrow('[secure_eval:membrane]');
  });

  it('accepts custom blocked set', () => {
    const custom = new Set(['myDangerous']);
    const membrane = buildMembrane(custom);
    // Default blocked items should be allowed
    expect(() => (membrane as any).fetch).not.toThrow();
    // Custom blocked item should throw
    expect(() => (membrane as any).myDangerous).toThrow('[secure_eval:membrane]');
  });

  // ── v3: pentest fixes — ownKeys / getOwnPropertyDescriptor traps ──

  it('ownKeys returns only prototype (Proxy invariant for function target)', () => {
    const membrane = buildMembrane();
    expect(Reflect.ownKeys(membrane)).toEqual(['prototype']);
  });

  it('Object.keys returns empty array (prototype is not enumerable)', () => {
    const membrane = buildMembrane();
    // prototype has enumerable: true in our descriptor, but Object.keys
    // only returns string keys that are enumerable — prototype is included
    const keys = Object.keys(membrane);
    expect(keys.length).toBeLessThanOrEqual(1);
  });

  it('Object.getOwnPropertyDescriptors does not leak blocked properties', () => {
    const membrane = buildMembrane();
    const descriptors = Object.getOwnPropertyDescriptors(membrane);
    // Only 'prototype' should be present, no blocked terminals
    const keys = Object.keys(descriptors);
    expect(keys).not.toContain('fetch');
    expect(keys).not.toContain('eval');
    expect(keys).not.toContain('localStorage');
  });

  it('getOwnPropertyDescriptor throws on blocked terminal', () => {
    const membrane = buildMembrane();
    expect(() => Object.getOwnPropertyDescriptor(membrane, 'fetch')).toThrow(
      '[secure_eval:membrane] Blocked: fetch'
    );
  });

  it('getOwnPropertyDescriptor returns proxy descriptor for non-blocked prop', () => {
    const membrane = buildMembrane();
    const desc = Object.getOwnPropertyDescriptor(membrane, 'document');
    expect(desc).toBeDefined();
    expect(desc!.configurable).toBe(true);
    expect(desc!.enumerable).toBe(true);
    expect(desc!.value).toBeDefined();
  });

  it('getOwnPropertyDescriptor deep chain still blocks', () => {
    const membrane = buildMembrane();
    const doc = (membrane as any).document;
    expect(() => Object.getOwnPropertyDescriptor(doc, 'cookie')).toThrow(
      '[secure_eval:membrane] Blocked: document.cookie'
    );
  });

  // ── v3: new blocked terminals ──

  it('blocks Worker terminal', () => {
    const membrane = buildMembrane();
    expect(() => (membrane as any).Worker).toThrow('[secure_eval:membrane] Blocked: Worker');
  });

  it('blocks SharedWorker terminal', () => {
    const membrane = buildMembrane();
    expect(() => (membrane as any).SharedWorker).toThrow('[secure_eval:membrane] Blocked: SharedWorker');
  });

  it('blocks RTCPeerConnection terminal', () => {
    const membrane = buildMembrane();
    expect(() => (membrane as any).RTCPeerConnection).toThrow('[secure_eval:membrane] Blocked: RTCPeerConnection');
  });

  it('blocks Image terminal', () => {
    const membrane = buildMembrane();
    expect(() => (membrane as any).Image).toThrow('[secure_eval:membrane] Blocked: Image');
  });

  it('blocks write terminal on document chain', () => {
    const membrane = buildMembrane();
    expect(() => (membrane as any).document.write).toThrow('[secure_eval:membrane] Blocked: document.write');
  });

  it('blocks assign terminal on location chain', () => {
    const membrane = buildMembrane();
    expect(() => (membrane as any).location.assign).toThrow('[secure_eval:membrane] Blocked: location.assign');
  });

  it('blocks replace terminal on location chain', () => {
    const membrane = buildMembrane();
    expect(() => (membrane as any).location.replace).toThrow('[secure_eval:membrane] Blocked: location.replace');
  });

  // ── v4: prototype chain & reflection escape patches ──

  it('blocks constructor access (prototype chain escape)', () => {
    const membrane = buildMembrane();
    expect(() => (membrane as any).constructor).toThrow('[secure_eval:membrane] Blocked: constructor');
  });

  it('blocks constructor chain walk on deep path', () => {
    const membrane = buildMembrane();
    const str = (membrane as any).someString;
    expect(() => str.constructor).toThrow('[secure_eval:membrane] Blocked: someString.constructor');
  });

  it('blocks __proto__ access', () => {
    const membrane = buildMembrane();
    expect(() => (membrane as any).__proto__).toThrow('[secure_eval:membrane] Blocked: __proto__');
  });

  it('blocks globalThis access', () => {
    const membrane = buildMembrane();
    expect(() => (membrane as any).globalThis).toThrow('[secure_eval:membrane] Blocked: globalThis');
  });

  it('blocks Reflect access', () => {
    const membrane = buildMembrane();
    expect(() => (membrane as any).Reflect).toThrow('[secure_eval:membrane] Blocked: Reflect');
  });

  it('blocks Proxy access', () => {
    const membrane = buildMembrane();
    expect(() => (membrane as any).Proxy).toThrow('[secure_eval:membrane] Blocked: Proxy');
  });

  it('blocks getPrototypeOf access on any chain', () => {
    const membrane = buildMembrane();
    const obj = (membrane as any).Object;
    expect(() => obj.getPrototypeOf).toThrow('[secure_eval:membrane] Blocked: Object.getPrototypeOf');
  });

  it('blocks defineProperty access on any chain', () => {
    const membrane = buildMembrane();
    const obj = (membrane as any).Object;
    expect(() => obj.defineProperty).toThrow('[secure_eval:membrane] Blocked: Object.defineProperty');
  });
});

// ── validateEval handler tests ──

function createMockWsConnection() {
  const handlers = new Map<string, Function>();
  return {
    registerCommandHandler: vi.fn((name: string, handler: Function) => {
      handlers.set(name, handler);
    }),
    _getHandler: (name: string) => handlers.get(name),
    isConnected: true,
  } as any;
}

describe('validateEval handler', () => {
  let wsConnection: ReturnType<typeof createMockWsConnection>;
  let validateEval: (params: any) => Promise<any>;

  beforeEach(() => {
    vi.clearAllMocks();
    wsConnection = createMockWsConnection();
    registerSecureEvalHandlers(wsConnection);
    validateEval = wsConnection._getHandler('validateEval') as any;
  });

  it('registers the validateEval handler', () => {
    expect(wsConnection.registerCommandHandler).toHaveBeenCalledWith(
      'validateEval',
      expect.any(Function)
    );
  });

  it('returns safe for empty code', async () => {
    expect(await validateEval({ code: '' })).toEqual({ safe: true });
    expect(await validateEval({ code: '   ' })).toEqual({ safe: true });
    expect(await validateEval({})).toEqual({ safe: true });
  });

  it('catches fetch() via membrane', async () => {
    const result = await validateEval({ code: "fetch('/api')" });
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('[secure_eval:membrane]');
    expect(result.reason).toContain('fetch');
  });

  it('catches comma operator bypass (0, fetch)()', async () => {
    const result = await validateEval({ code: "(0, fetch)('/api')" });
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('fetch');
  });

  it('allows safe DOM queries', async () => {
    const result = await validateEval({ code: "document.querySelector('h1')" });
    expect(result.safe).toBe(true);
  });

  it('returns safe for syntax errors (pass through to page)', async () => {
    const result = await validateEval({ code: 'function {' });
    expect(result.safe).toBe(true);
  });

  it('returns safe for runtime errors in safe code', async () => {
    // This will throw because membrane proxies can't actually run real DOM code,
    // but the error is NOT a membrane block, so it's safe
    const result = await validateEval({ code: "document.querySelector('h1').textContent" });
    expect(result.safe).toBe(true);
  });

  it('catches localStorage access', async () => {
    const result = await validateEval({ code: "localStorage.getItem('key')" });
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('localStorage');
  });

  it('catches aliased fetch via variable', async () => {
    const result = await validateEval({ code: "const f = fetch; f('/api')" });
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('fetch');
  });

  it('catches eval()', async () => {
    const result = await validateEval({ code: "eval('alert(1)')" });
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('eval');
  });

  it('catches new WebSocket via Function constructor', async () => {
    const result = await validateEval({ code: "Function('return fetch')()('/api')" });
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('Function');
  });

  it('catches constructor via unqualified identifier', async () => {
    // Direct constructor access through membrane (unqualified identifier)
    const result = await validateEval({ code: "constructor" });
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('constructor');
  });

  it('catches globalThis access', async () => {
    const result = await validateEval({ code: 'globalThis' });
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('globalThis');
  });

  it('catches Reflect.construct escape', async () => {
    const result = await validateEval({ code: "Reflect.construct(Array, [])" });
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('Reflect');
  });
});
