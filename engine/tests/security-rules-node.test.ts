/**
 * The Node-vm blocklist. Layer 1 of three.
 *
 * These rules exist to give an author a clear, early error — NOT to contain a
 * determined attacker. Static analysis cannot decide what dynamic JavaScript
 * does. Containment is the child process (Layer 3). Do not add a rule here on
 * the theory that it "closes a hole"; add it because it turns a confusing
 * runtime failure into a readable validation message.
 */
import { describe, it, expect } from 'vitest';
import { analyzeWithRules } from '../src/security/analyzer';
import { nodeRules, evalUsageRules } from '../src/security/rules/node';

const check = (code: string) => analyzeWithRules(code, nodeRules);

describe('nodeRules — module loading', () => {
  it.each([
    ["require('fs')", 'require'],
    ["require('node:child_process')", 'require'],
    ["import('fs')", 'Dynamic import'],
    ["import fs from 'fs';", 'Static import'],
    ["import { readFile } from 'node:fs/promises';", 'Static import'],
    ["export { x } from './other.js';", 'Static import'],
  ])('blocks %s', (code, reason) => {
    const r = check(code);
    expect(r.safe).toBe(false);
    expect(r.reason).toContain(reason);
  });
});

describe('nodeRules — host realm escape', () => {
  it.each([
    ['supersurf.click.constructor', 'Prototype chain walking'],
    ["o['constructor']", 'Prototype chain walking'],
    ['o.__proto__', 'Prototype chain walking'],
    ['process.exit(1)', 'Node host global'],
    ['process.env.SECRET', 'Node host global'],
    ['global.foo', 'Node host global'],
    ['globalThis.foo', 'Node host global'],
    ['Buffer.from("x")', 'Node host global'],
    ["eval('1+1')", 'Dynamic code generation'],
    ["Function('return 1')", 'Dynamic code generation'],
    ["new Function('return 1')", 'Dynamic code generation'],
    ["WebAssembly.compile(b)", 'Dynamic code generation'],
  ])('blocks %s', (code, reason) => {
    const r = check(code);
    expect(r.safe).toBe(false);
    expect(r.reason).toContain(reason);
  });
});

describe('nodeRules — reflection', () => {
  it.each([
    ["Reflect.get(o, 'p')", 'Reflection'],
    ['new Proxy({}, {})', 'Reflection'],
    ['Object.getPrototypeOf(o)', 'Prototype manipulation'],
    ['Object.setPrototypeOf(o, null)', 'Prototype manipulation'],
    ["Object.defineProperty(o, 'p', {})", 'Prototype manipulation'],
    ["Object.getOwnPropertyDescriptor(o, 'p')", 'Prototype manipulation'],
    ["Object.getOwnPropertyDescriptors(o)", 'Prototype manipulation'],
  ])('blocks %s', (code, reason) => {
    const r = check(code);
    expect(r.safe).toBe(false);
    expect(r.reason).toContain(reason);
  });
});

describe('nodeRules — allows ordinary playbook code', () => {
  const PLAYBOOK = `
export const meta = {
  description: 'Post a tweet',
  params: { text: { type: 'string', required: true } },
  profile: 'developer',
  startingPoint: 'x.com',
};

export default async function ({ supersurf, params }) {
  await supersurf.goto('https://x.com/home');
  await supersurf.click('[data-testid="tweetButton"]');
  await supersurf.type('[role="textbox"]', params.text);
  const posted = await supersurf.seeText('Your post was sent');
  const rows = await supersurf.extract({ mode: 'text' });
  return { posted, rows: rows.length, sum: [1, 2, 3].reduce((a, b) => a + b, 0) };
}
`;

  it('allows a full realistic playbook', () => {
    expect(check(PLAYBOOK)).toEqual({ safe: true });
  });

  it.each([
    'const x = { constructorName: 1 };',   // not the `constructor` property
    'for (const r of rows) { total += r.n; }',
    'try { await supersurf.click("#a"); } catch (e) { log(e.message); }',
    'const s = `hello ${params.name}`;',
    'JSON.stringify({ a: 1 });',
    'Object.keys(o).length;',
    'Object.entries(o).map(([k, v]) => k + v);',
    'Math.max(1, 2);',
    'new Date().toISOString();',
    'new Map(); new Set(); new RegExp("a");',
    'await supersurf.wait(500);',
  ])('allows %s', (code) => {
    expect(check(code)).toEqual({ safe: true });
  });
});

describe('evalUsageRules — only applied when the eval permission is absent', () => {
  it('blocks supersurf.evaluate(...)', () => {
    const r = analyzeWithRules("await supersurf.evaluate('1+1')", evalUsageRules);
    expect(r.safe).toBe(false);
    expect(r.reason).toContain('permissions');
  });

  it('blocks a bare supersurf.evaluate reference', () => {
    expect(analyzeWithRules('const e = supersurf.evaluate;', evalUsageRules).safe).toBe(false);
  });

  it('allows every other supersurf method', () => {
    expect(analyzeWithRules("await supersurf.click('#a')", evalUsageRules)).toEqual({ safe: true });
  });

  it('is NOT part of nodeRules — nodeRules alone permits evaluate', () => {
    expect(check("await supersurf.evaluate('1+1')")).toEqual({ safe: true });
  });
});
