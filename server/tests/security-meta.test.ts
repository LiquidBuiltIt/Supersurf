import { describe, it, expect } from 'vitest';
import { parseMeta } from '../src/security/meta';

const wrap = (metaSrc: string) =>
  `export const meta = ${metaSrc};\nexport default async function () {}\n`;

describe('parseMeta — happy path', () => {
  it('parses a full meta literal', () => {
    const { meta, error } = parseMeta(wrap(`{
      description: 'Post a tweet',
      params: {
        text: { type: 'string', required: true, description: 'The body' },
        pin: { type: 'boolean' },
        count: { type: 'number', required: false },
      },
      profile: 'developer',
      permissions: ['eval'],
      startingPoint: 'x.com',
    }`));
    expect(error).toBeUndefined();
    expect(meta).toEqual({
      description: 'Post a tweet',
      params: {
        text: { type: 'string', required: true, description: 'The body' },
        pin: { type: 'boolean' },
        count: { type: 'number', required: false },
      },
      profile: 'developer',
      permissions: ['eval'],
      startingPoint: 'x.com',
    });
  });

  it('parses a minimal meta — description only', () => {
    expect(parseMeta(wrap(`{ description: 'Do a thing' }`)).meta).toEqual({ description: 'Do a thing' });
  });

  it('accepts string-literal keys', () => {
    expect(parseMeta(wrap(`{ 'description': 'x' }`)).meta).toEqual({ description: 'x' });
  });

  it('accepts a template literal with no interpolation', () => {
    expect(parseMeta(wrap('{ description: `plain` }')).meta).toEqual({ description: 'plain' });
  });

  it('finds meta regardless of position in the file', () => {
    const src = `export default async function () {}\nexport const meta = { description: 'after' };\n`;
    expect(parseMeta(src).meta).toEqual({ description: 'after' });
  });
});

describe('parseMeta — rejections', () => {
  const rejects = (src: string, fragment: string) => {
    const { meta, error } = parseMeta(src);
    expect(meta).toBeUndefined();
    expect(error).toBeDefined();
    expect(error).toContain(fragment);
  };

  it('rejects a file with no meta export', () => {
    rejects('export default async function () {}\n', 'export const meta');
  });

  it('rejects a non-object meta', () => {
    rejects(wrap(`'nope'`), 'object literal');
  });

  it('rejects a computed key', () => {
    rejects(wrap(`{ [key]: 'x', description: 'y' }`), 'computed key');
  });

  it('rejects a method', () => {
    rejects(wrap(`{ description: 'x', build() { return 1; } }`), 'method');
  });

  it('rejects a getter', () => {
    rejects(wrap(`{ description: 'x', get params() { return {}; } }`), 'method');
  });

  it('rejects spread', () => {
    rejects(wrap(`{ ...base, description: 'x' }`), 'spread');
  });

  it('rejects template interpolation', () => {
    rejects(wrap('{ description: `hi ${name}` }'), 'interpolation');
  });

  it('rejects a computed value', () => {
    rejects(wrap(`{ description: 'x', params: buildParams() }`), 'literal');
  });

  it('rejects an identifier reference as a value', () => {
    rejects(wrap(`{ description: someConst }`), 'literal');
  });

  it.each(['__proto__', 'constructor', 'prototype'])('rejects the key %s', (key) => {
    rejects(wrap(`{ description: 'x', ${key}: 'y' }`), 'forbidden key');
  });

  it('rejects __proto__ nested inside params', () => {
    rejects(wrap(`{ description: 'x', params: { __proto__: { type: 'string' } } }`), 'forbidden key');
  });

  it('rejects unparseable source', () => {
    rejects('export const meta = { (((', 'parse');
  });

  it('rejects a missing description', () => {
    rejects(wrap(`{ profile: 'developer' }`), 'description');
  });

  it('rejects a non-string description', () => {
    rejects(wrap(`{ description: 42 }`), 'description');
  });

  it('rejects an unknown param type', () => {
    rejects(wrap(`{ description: 'x', params: { a: { type: 'object' } } }`), "type must be one of");
  });

  it('rejects a param spec that is not an object', () => {
    rejects(wrap(`{ description: 'x', params: { a: 'string' } }`), 'param "a"');
  });

  it('rejects a non-array permissions', () => {
    rejects(wrap(`{ description: 'x', permissions: 'eval' }`), 'permissions');
  });

  // ── Addendum B: meta.experiments ──
  it('accepts experiments: true', () => {
    expect(parseMeta(wrap(`{ description: 'x', experiments: true }`)).meta)
      .toEqual({ description: 'x', experiments: true });
  });

  it('accepts experiments: false', () => {
    expect(parseMeta(wrap(`{ description: 'x', experiments: false }`)).meta)
      .toEqual({ description: 'x', experiments: false });
  });

  it('leaves experiments absent when the key is not present', () => {
    expect(parseMeta(wrap(`{ description: 'x' }`)).meta).not.toHaveProperty('experiments');
  });

  it('rejects a non-boolean experiments with a clear message', () => {
    const r = parseMeta(wrap(`{ description: 'x', experiments: ['fingerprinting'] }`));
    expect(r.meta).toBeUndefined();
    expect(r.error).toContain('experiments must be a boolean');
  });

  it('rejects a string experiments value', () => {
    rejects(wrap(`{ description: 'x', experiments: 'all' }`), 'experiments must be a boolean');
  });

  it('does not accept experiments under permissions — different axis', () => {
    // permissions is a string array, so this parses; it just never turns
    // experiments on. Activation reads meta.experiments and nothing else.
    const meta = parseMeta(wrap(`{ description: 'x', permissions: ['experiments'] }`)).meta!;
    expect(meta.experiments).toBeUndefined();
  });

  it('rejects a non-string entry in permissions', () => {
    rejects(wrap(`{ description: 'x', permissions: [1] }`), 'permissions');
  });

  it('rejects a non-string profile', () => {
    rejects(wrap(`{ description: 'x', profile: 3 }`), 'profile');
  });

  it('rejects an unknown top-level key', () => {
    rejects(wrap(`{ description: 'x', retries: 3 }`), 'unknown key');
  });
});
