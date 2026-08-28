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

  it('THE LOCK: a HOST function reached via .constructor no longer compiles', () => {
    // This USED to be a characterization test recording an escape: a function
    // injected from the host kept its host-realm `.constructor`, that
    // constructor compiled in the HOST realm where codegen is allowed, and
    // `supersurf.click.constructor('return this')()` handed back the host
    // global in one line. `createPlaybookContext` now re-realms every injected
    // value, so `.constructor` is the VM realm's AsyncFunction and the flag
    // bites. Inverted deliberately — do not restore the old assertion.
    const ctx = createPlaybookContext({ supersurf: { click: async () => {} } });
    expect(() => new vm.Script('supersurf.click.constructor("return this")()').runInContext(ctx))
      .toThrow(/[Cc]ode generation/);
  });

  it('dynamic import throws rather than reaching the host loader', () => {
    const ctx = createPlaybookContext({});
    const script = compilePlaybook('export default () => import("fs");\n', 'test.playbook.js');
    script.runInContext(ctx);
    return expect(ctx[DEFAULT_EXPORT_KEY]()).rejects.toThrow();
  });
});

describe('createPlaybookContext — injected host values are re-realmed', () => {
  /** Run a host-compiled expression inside a fresh context. */
  function evalIn(ctx: any, expression: string): any {
    return new vm.Script(expression).runInContext(ctx);
  }

  it('drops the temporary handoff key — only the intended globals remain', () => {
    const ctx = createPlaybookContext({ supersurf: { click: async () => {} }, params: { a: 1 }, log: () => {} });
    expect(Object.keys(ctx).sort()).toEqual([DEFAULT_EXPORT_KEY, 'console', 'log', 'params', 'supersurf'].sort());
  });

  it('wraps functions nested at any depth in the client', () => {
    const ctx = createPlaybookContext({ supersurf: { tabs: { new: async () => {} } } });
    expect(evalIn(ctx, 'typeof supersurf.tabs.new')).toBe('function');
    expect(() => evalIn(ctx, 'supersurf.tabs.new.constructor("return this")()'))
      .toThrow(/[Cc]ode generation/);
    expect(() => evalIn(ctx, 'supersurf.tabs.constructor.constructor("return this")()'))
      .toThrow(/[Cc]ode generation/);
  });

  it('does not resurrect a method buildClient declined to create', () => {
    const ctx = createPlaybookContext({ supersurf: { click: async () => {} } });
    expect(evalIn(ctx, 'typeof supersurf.evaluate')).toBe('undefined');
    expect(evalIn(ctx, 'Object.keys(supersurf).join(",")')).toBe('click');
  });

  it('THE RETURNED PROMISE is vm-realm — .constructor.constructor does not compile', async () => {
    const ctx = createPlaybookContext({ supersurf: { click: async () => ({ success: true }) } });
    expect(evalIn(ctx, 'supersurf.click() instanceof Promise')).toBe(true);
    const verdict = await evalIn(ctx, `(() => {
      try { supersurf.click().constructor.constructor("return this")(); return "ESCAPED"; }
      catch (e) { return "blocked"; }
    })()`);
    expect(verdict).toBe('blocked');
  });

  it('THE RESOLVED VALUE is vm-realm — .constructor.constructor does not compile', async () => {
    const ctx = createPlaybookContext({ supersurf: { click: async () => ({ nested: { deep: 1 } }) } });
    const out = await evalIn(ctx, `(async () => {
      const r = await supersurf.click();
      const probe = (v) => { try { v.constructor.constructor("return this")(); return "ESCAPED"; } catch (e) { return "blocked"; } };
      return { deep: r.nested.deep, top: probe(r), inner: probe(r.nested) };
    })()`);
    expect(out.deep).toBe(1);
    expect(out.top).toBe('blocked');
    expect(out.inner).toBe('blocked');
  });

  it('passes primitives, null and undefined results through without a round trip', async () => {
    const ctx = createPlaybookContext({
      supersurf: {
        seeText: async () => true,
        nul: async () => null,
        und: async () => undefined,
        num: async () => 42,
      },
    });
    const out = await evalIn(ctx, `(async () => [
      await supersurf.seeText(), await supersurf.nul(),
      typeof (await supersurf.und()), await supersurf.num(),
    ])()`);
    expect(Array.from(out)).toEqual([true, null, 'undefined', 42]);
  });

  it('THE THROWN ERROR is vm-realm and keeps its message', async () => {
    const ctx = createPlaybookContext({ supersurf: { click: async () => { throw new Error('click failed: no such element'); } } });
    const out = await evalIn(ctx, `(async () => {
      try { await supersurf.click(); return { caught: false }; }
      catch (e) {
        let escape = 'blocked';
        try { e.constructor.constructor("return this")(); escape = 'ESCAPED'; } catch (x) {}
        return { caught: true, message: e.message, isVmError: e instanceof Error, escape };
      }
    })()`);
    expect(out.caught).toBe(true);
    expect(out.message).toBe('click failed: no such element');
    expect(out.isVmError).toBe(true);
    expect(out.escape).toBe('blocked');
  });

  it('PARAMS is a vm-realm object at every depth, values intact', () => {
    const ctx = createPlaybookContext({ params: { text: 'hi', nested: { pin: true }, list: [{ a: 1 }] } });
    expect(evalIn(ctx, 'params.text')).toBe('hi');
    expect(evalIn(ctx, 'params.nested.pin')).toBe(true);
    expect(evalIn(ctx, 'Array.isArray(params.list) && params.list[0].a')).toBe(1);
    for (const path of ['params', 'params.nested', 'params.list', 'params.list[0]']) {
      expect(() => evalIn(ctx, `${path}.constructor.constructor("return this")()`))
        .toThrow(/[Cc]ode generation/);
    }
  });

  it('LOG is wrapped, still fires synchronously, and does not compile', () => {
    const seen: string[] = [];
    const ctx = createPlaybookContext({ log: (m: unknown) => { seen.push(String(m)); } });
    evalIn(ctx, 'log("opening composer")');
    expect(seen).toEqual(['opening composer']); // synchronous — playbooks do not await log()
    expect(() => evalIn(ctx, 'log.constructor("return this")()')).toThrow(/[Cc]ode generation/);
  });
});
