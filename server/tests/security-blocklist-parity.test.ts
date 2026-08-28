/**
 * Blocklist parity lock — a CHARACTERIZATION test.
 *
 * SuperSurf has three blocklists that disagree with each other:
 *   1. BLOCKED_PATTERNS   (server, AST layer)      — secure-eval.ts:68
 *   2. PAGE_BLOCKED       (server, page proxy)     — secure-eval.ts:439
 *   3. BLOCKED_TERMINALS  (extension, membrane)    — membrane.ts:21
 *
 * This file records that disagreement EXACTLY AS IT IS TODAY. It is not a
 * statement that the current state is correct — it is a tripwire, so that a
 * refactor of the analyzer cannot silently change what gets blocked.
 *
 * DO NOT "fix" the divergence to make this file shorter. If you intend to
 * reconcile the lists, that is a separate, deliberate change with its own PR.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { analyzeCode, wrapWithPageProxy } from '../src/tools/browser_evaluate/secure-eval';

// ── List 2: extract PAGE_BLOCKED / SUB_OBJECT_RULES from the emitted wrapper ──

const WRAPPED = wrapWithPageProxy('1');

function extractPageBlocked(): string[] {
  const m = WRAPPED.match(/var __blocked = new Set\((\[[^\]]*\])\);/);
  if (!m) throw new Error('wrapWithPageProxy no longer emits `var __blocked = new Set([...]);`');
  return JSON.parse(m[1]);
}

function extractSubRules(): Record<string, { blocked: string[]; aliases: Record<string, string> }> {
  const m = WRAPPED.match(/var __subRules = (\{.*?\});\n/s);
  if (!m) throw new Error('wrapWithPageProxy no longer emits `var __subRules = {...};`');
  return JSON.parse(m[1]);
}

// ── List 3: read the extension membrane as text (BLOCKED_TERMINALS is private) ──

function extractBlockedTerminals(): string[] {
  const file = path.resolve(__dirname, '../../extension/src/security/secure-eval/membrane.ts');
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/const BLOCKED_TERMINALS = new Set\(\[([\s\S]*?)\]\);/);
  if (!m) throw new Error('membrane.ts no longer declares `const BLOCKED_TERMINALS = new Set([...]);`');
  return Array.from(m[1].matchAll(/'([^']+)'/g)).map(x => x[1]);
}

describe('blocklist parity — list contents', () => {
  it('PAGE_BLOCKED is exactly these 16 names', () => {
    expect(extractPageBlocked()).toEqual([
      'fetch', 'eval', 'atob', 'btoa', 'Function',
      'WebSocket', 'XMLHttpRequest', 'EventSource', 'Image',
      'Worker', 'SharedWorker', 'RTCPeerConnection',
      'importScripts', 'open',
      'localStorage', 'sessionStorage',
    ]);
  });

  it('SUB_OBJECT_RULES is exactly these three objects', () => {
    expect(extractSubRules()).toEqual({
      document: { blocked: ['cookie', 'write', 'writeln'], aliases: { defaultView: '__proxy' } },
      navigator: { blocked: ['sendBeacon'], aliases: {} },
      location: { blocked: ['assign', 'replace'], aliases: {} },
    });
  });

  it('the extension membrane blocks all 16 PAGE_BLOCKED names plus 15 more', () => {
    const terminals = extractBlockedTerminals();
    const page = extractPageBlocked();
    expect(terminals).toHaveLength(31);
    for (const name of page) expect(terminals).toContain(name);
    const extras = terminals.filter(t => !page.includes(t)).sort();
    expect(extras).toEqual([
      'Proxy', 'Reflect', '__proto__', 'assign', 'constructor', 'cookie',
      'defaultView', 'defineProperty', 'getPrototypeOf', 'globalThis',
      'replace', 'sendBeacon', 'setPrototypeOf', 'write', 'writeln',
    ]);
  });
});

// ── List 1: probe the AST layer through its public entry point ──

/** Snippets the AST layer rejects today, with the exact reason it gives. */
const AST_BLOCKED: Array<[string, string]> = [
  ["fetch('/a')",                              'Direct call to blocked API'],
  ["eval('1')",                                'Direct call to blocked API'],
  ["atob('a')",                                'Direct call to blocked API'],
  ["btoa('b')",                                'Direct call to blocked API'],
  ["Function('return 1')",                     'Direct call to blocked API'],
  ["window.fetch('/a')",                       'Direct call to blocked API'],
  ["(0, fetch)('/a')",                         'Comma operator bypass to blocked API'],
  ["this.fetch('/a')",                         'Blocked API call via this'],
  ["const f = window.fetch;",                  'Blocked API reference on global object'],
  ["Object.getOwnPropertyDescriptor(o, 'p')",  'Property descriptor extraction'],
  ["document.createElement('iframe')",         'Blocked element creation'],
  ["document.createElement('script')",         'Blocked element creation'],
  ["String.fromCharCode(97)",                  'String obfuscation primitive'],
  ["setTimeout('x()', 0)",                     'setTimeout/setInterval with string argument'],
  ["Reflect.get(o, 'p')",                      'Reflection API'],
  ["navigator.sendBeacon('/x')",               'Network exfiltration via navigator.sendBeacon'],
  ["location.assign('/x')",                    'Navigation hijack'],
  ["location.replace('/x')",                   'Navigation hijack'],
  ["localStorage.getItem('k')",                'Direct storage access'],
  ["sessionStorage.foo",                       'Direct storage access'],
  ["document.cookie",                          'Direct cookie access'],
  ["document['cookie']",                       'Direct cookie access'],
  ["window['fe' + 'tch']",                     'Computed property access on global object'],
  ["document.defaultView",                     'Window alias via document.defaultView'],
  ["o.constructor",                            'Prototype chain walking'],
  ["o.__proto__",                              'Prototype chain walking'],
  ["new WebSocket('ws://x')",                  'Dangerous constructor'],
  ["new XMLHttpRequest()",                     'Dangerous constructor'],
  ["new EventSource('/x')",                    'Dangerous constructor'],
  ["new Image()",                              'Dangerous constructor'],
  ["new Worker('w.js')",                       'Dangerous constructor'],
  ["new SharedWorker('w.js')",                 'Dangerous constructor'],
  ["new RTCPeerConnection()",                  'Dangerous constructor'],
  ["import('./x.js')",                         'Dynamic import() expression'],
  ["String.raw`x`",                            'String obfuscation primitive'],
  ["const u = 'javascript:alert(1)';",         'javascript: protocol string literal'],
];

/**
 * Snippets the AST layer ALLOWS today even though one of the other two lists
 * blocks the same name. This is the divergence. Each entry is a real hole in
 * Layer 1 that Layers 2/3 happen to cover — recorded, not fixed.
 */
const AST_ALLOWED_BUT_BLOCKED_ELSEWHERE = [
  "importScripts('/x.js')",       // in PAGE_BLOCKED + membrane
  "open('/x')",                   // in PAGE_BLOCKED + membrane
  "window.open('/x')",            // in PAGE_BLOCKED + membrane
  "document.write('x')",          // in SUB_OBJECT_RULES + membrane
  "document.writeln('x')",        // in SUB_OBJECT_RULES + membrane
  "globalThis;",                  // in membrane
  "new Proxy({}, {});",           // in membrane
  "Object.getPrototypeOf(o)",     // in membrane
  "Object.setPrototypeOf(o, null)", // in membrane
  "Object.defineProperty(o, 'p', {})", // in membrane
];

describe('blocklist parity — AST layer behavior', () => {
  it.each(AST_BLOCKED)('blocks %s', (code, reason) => {
    const result = analyzeCode(code);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain(reason);
  });

  it.each(AST_ALLOWED_BUT_BLOCKED_ELSEWHERE)('allows %s (divergence, not a bug to fix here)', (code) => {
    expect(analyzeCode(code)).toEqual({ safe: true });
  });

  it('allows a static import declaration — no rule walks ImportDeclaration', () => {
    expect(analyzeCode("import fs from 'fs';\nexport default 1;")).toEqual({ safe: true });
  });

  it('treats empty and whitespace-only code as safe', () => {
    expect(analyzeCode('')).toEqual({ safe: true });
    expect(analyzeCode('   \n  ')).toEqual({ safe: true });
  });

  it('treats unparseable code as safe — callers surface their own syntax errors', () => {
    expect(analyzeCode('function (((')).toEqual({ safe: true });
  });

  it('allows ordinary DOM reads', () => {
    expect(analyzeCode("document.querySelectorAll('a').length")).toEqual({ safe: true });
    expect(analyzeCode("return [...document.querySelectorAll('h2')].map(e => e.textContent)")).toEqual({ safe: true });
  });
});
