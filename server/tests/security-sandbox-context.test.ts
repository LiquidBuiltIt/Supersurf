import { describe, it, expect } from 'vitest';
import vm from 'vm';
import {
  stripModuleSyntax,
  createPlaybookContext,
  compilePlaybook,
  DEFAULT_EXPORT_KEY,
} from '../src/security/sandbox/context';

/** Compile + run a snippet in a fresh playbook context, returning the context. */
function run(source: string, globals: Record<string, unknown> = {}): any {
  const ctx = createPlaybookContext(globals);
  compilePlaybook(source, 'test.playbook.js').runInContext(ctx);
  return ctx;
}

describe('stripModuleSyntax', () => {
  it('preserves the exact byte length', () => {
    const src = `export const meta = { description: 'x' };\nexport default async function () { return 1; }\n`;
    expect(stripModuleSyntax(src)).toHaveLength(src.length);
  });

  it('preserves line count and the column of the default function body', () => {
    const src = `export const meta = { description: 'x' };\nexport default async function () { return 1; }\n`;
    const out = stripModuleSyntax(src);
    expect(out.split('\n')).toHaveLength(src.split('\n').length);
    expect(out.indexOf('async function')).toBe(src.indexOf('async function'));
  });

  it('rewrites `export default` into an assignment to the default-export key', () => {
    const out = stripModuleSyntax('export default async function () {}\n');
    expect(out.trimStart().startsWith(`${DEFAULT_EXPORT_KEY} =`)).toBe(true);
  });

  it('keeps a named export as a plain declaration', () => {
    const out = stripModuleSyntax(`export const meta = { description: 'x' };\n`);
    expect(out).toContain("const meta = { description: 'x' };");
    expect(out).not.toContain('export');
  });

  it('blanks a bare export specifier list but keeps its newlines', () => {
    const src = 'const a = 1;\nexport { a };\nconst b = 2;\n';
    const out = stripModuleSyntax(src);
    expect(out).toHaveLength(src.length);
    expect(out.split('\n')).toHaveLength(src.split('\n').length);
    expect(out).not.toContain('export');
  });

  it('handles extra whitespace between export and default', () => {
    const src = 'export   default 42;\n';
    const out = stripModuleSyntax(src);
    expect(out).toHaveLength(src.length);
    expect(out).toContain(`${DEFAULT_EXPORT_KEY} =`);
  });

  it('leaves source with no module syntax untouched', () => {
    const src = 'const a = 1;\nfunction f() { return a; }\n';
    expect(stripModuleSyntax(src)).toBe(src);
  });

  it('returns the source unchanged when it does not parse — the caller reports the syntax error', () => {
    expect(stripModuleSyntax('export default (((')).toBe('export default (((');
  });
});

describe('createPlaybookContext — the default export lands on the context', () => {
  it('exposes the default export under DEFAULT_EXPORT_KEY', () => {
    const ctx = run('export default async function () { return 7; }\n');
    expect(typeof ctx[DEFAULT_EXPORT_KEY]).toBe('function');
  });

  it('works when the playbook opts into strict mode', () => {
    const ctx = run(`'use strict';\nexport default function () { return 1; }\n`);
    expect(typeof ctx[DEFAULT_EXPORT_KEY]).toBe('function');
  });

  it('passes supplied globals through', () => {
    const ctx = run('export default () => params.a + 1;\n', { params: { a: 1 } });
    expect(ctx[DEFAULT_EXPORT_KEY]()).toBe(2);
  });
});

describe('createPlaybookContext — Node globals are absent by omission', () => {
  it.each(['require', 'process', 'Buffer', 'module', 'exports', 'console', 'setTimeout', 'setInterval', '__dirname', '__filename'])(
    '%s is undefined inside the vm',
    (name) => {
      const ctx = run(`export default () => typeof ${name};\n`);
      expect(ctx[DEFAULT_EXPORT_KEY]()).toBe('undefined');
    },
  );

  it('the vm global has a null prototype — globalThis.constructor is undefined', () => {
    const ctx = run('export default () => typeof globalThis.constructor;\n');
    expect(ctx[DEFAULT_EXPORT_KEY]()).toBe('undefined');
  });

  it('still has the JS intrinsics a playbook actually needs', () => {
    const ctx = run('export default () => [typeof Promise, typeof JSON, typeof Object, typeof Math, typeof Date].join(",");\n');
    expect(ctx[DEFAULT_EXPORT_KEY]()).toBe('function,object,function,object,function');
  });
});

describe('createPlaybookContext — code generation is disabled', () => {
  it('eval throws', () => {
    const ctx = createPlaybookContext({});
    expect(() => new vm.Script('eval("1+1")').runInContext(ctx)).toThrow(/[Cc]ode generation/);
  });

  it('new Function throws', () => {
    const ctx = createPlaybookContext({});
    expect(() => new vm.Script('new Function("return 1")').runInContext(ctx)).toThrow(/[Cc]ode generation/);
  });

  it('THE LINCHPIN: the vm realm cannot build a function from a string, even via .constructor', () => {
    // Reaching Function through an intrinsic that BELONGS TO THE VM REALM is
    // what codeGeneration.strings=false stops. Without the flag this line
    // returns a working compiler and Layer 2 is over in one expression.
    const ctx = createPlaybookContext({});
    expect(() => new vm.Script('Object.constructor("return this")()').runInContext(ctx))
      .toThrow(/[Cc]ode generation/);
  });

  it('CHARACTERIZATION: codeGeneration does NOT contain a HOST function reached via .constructor', () => {
    // Verified against Node v22.22.3. `codeGeneration.strings: false` is scoped
    // to this context. A function injected from the host keeps its host-realm
    // `.constructor`, and that constructor compiles in the HOST realm, where
    // codegen is allowed — so this does not throw and hands back the host
    // global. Layer 2 is a filter, not a boundary; the containment for this is
    // Layer 3, the child process spawned with `env: {}` under Node's
    // permission model. Locked here so any change to that story is visible.
    const ctx = createPlaybookContext({ supersurf: { click: async () => {} } });
    const escaped = new vm.Script('supersurf.click.constructor("return this")()').runInContext(ctx);
    const vmGlobal = new vm.Script('globalThis').runInContext(ctx);
    expect(escaped).toBeTruthy();
    expect(escaped).not.toBe(vmGlobal);
  });

  it('dynamic import throws rather than reaching the host loader', () => {
    const ctx = createPlaybookContext({});
    const script = compilePlaybook('export default () => import("fs");\n', 'test.playbook.js');
    script.runInContext(ctx);
    return expect(ctx[DEFAULT_EXPORT_KEY]()).rejects.toThrow();
  });
});
