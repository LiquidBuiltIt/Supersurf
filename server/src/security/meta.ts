/**
 * Playbook metadata parsing — reads `export const meta = {...}` from source
 * text WITHOUT executing it.
 *
 * The listing surface reads signatures by parsing, never by running the file,
 * so `meta` must be a pure literal. A script whose meta is computed
 * (`params: buildParams()`) fails validation rather than silently breaking the
 * listing. The filename is the address, so `meta` has no `name` field.
 *
 * @module security/meta
 */

import * as acorn from 'acorn';

/** One declared parameter of a playbook. */
export interface PlaybookParamSpec {
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  description?: string;
}

/** The `meta` object a playbook file exports. */
export interface PlaybookMeta {
  description: string;                              // required
  params?: Record<string, PlaybookParamSpec>;
  profile?: string;                                 // default; caller may override
  permissions?: string[];                           // v1: only 'eval' is recognised
  startingPoint?: string;                           // bare domain, e.g. 'x.com'
  /** Addendum B. `true` enables every name in AVAILABLE_EXPERIMENTS for this
   *  run's session only; `false`/absent inherits the resolved config unchanged.
   *  Top level on purpose — permissions are a security boundary, experiments are
   *  a behavioral dependency. A boolean, never a list of names: a list rots when
   *  an experiment graduates and its toggle leaves AVAILABLE_EXPERIMENTS.
   *  Plan 2 only parses and type-checks it. ACTIVATION is Plan 3's — that is
   *  where the ConnectionManager lives. Do not build it here. */
  experiments?: boolean;                            // default false
}

/** Keys that are never legal anywhere inside the meta literal. */
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];

const TOP_LEVEL_KEYS = ['description', 'params', 'profile', 'permissions', 'startingPoint', 'experiments'];
const PARAM_KEYS = ['type', 'required', 'description'];
const PARAM_TYPES = ['string', 'number', 'boolean'];

/** Thrown internally and converted to `{ error }` at the boundary. */
class MetaError extends Error {}

/** Turn an AST node into a plain JS value, or throw MetaError. */
function literalValue(node: any, path: string): unknown {
  switch (node?.type) {
    case 'Literal':
      return node.value;
    case 'TemplateLiteral':
      if (node.expressions.length > 0) {
        throw new MetaError(`${path}: template interpolation is not allowed — meta must be a pure literal`);
      }
      return node.quasis[0]?.value?.cooked ?? '';
    case 'UnaryExpression':
      // Negative numbers parse as UnaryExpression('-', Literal).
      if (node.operator === '-' && node.argument?.type === 'Literal' && typeof node.argument.value === 'number') {
        return -node.argument.value;
      }
      throw new MetaError(`${path}: only literal values are allowed`);
    case 'ArrayExpression':
      return node.elements.map((el: any, i: number) => {
        if (el?.type === 'SpreadElement') {
          throw new MetaError(`${path}[${i}]: spread is not allowed`);
        }
        return literalValue(el, `${path}[${i}]`);
      });
    case 'ObjectExpression':
      return objectValue(node, path);
    default:
      throw new MetaError(`${path}: only literal values are allowed (got ${node?.type ?? 'nothing'})`);
  }
}

/** Turn an ObjectExpression into a plain object, or throw MetaError. */
function objectValue(node: any, path: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const prop of node.properties) {
    if (prop.type === 'SpreadElement') {
      throw new MetaError(`${path}: spread is not allowed — meta must be a pure literal`);
    }
    if (prop.computed) {
      throw new MetaError(`${path}: computed key is not allowed — meta must be a pure literal`);
    }
    if (prop.method || prop.kind !== 'init') {
      throw new MetaError(`${path}: method/getter/setter is not allowed — meta must be a pure literal`);
    }
    let key: string;
    if (prop.key.type === 'Identifier') key = prop.key.name;
    else if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') key = prop.key.value;
    else throw new MetaError(`${path}: unsupported key type ${prop.key.type}`);

    if (FORBIDDEN_KEYS.includes(key)) {
      throw new MetaError(`${path}: forbidden key "${key}"`);
    }
    out[key] = literalValue(prop.value, `${path}.${key}`);
  }
  return out;
}

/** Shape-check the parsed object and narrow it to PlaybookMeta, or throw MetaError. */
function toMeta(raw: Record<string, unknown>): PlaybookMeta {
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      throw new MetaError(`meta: unknown key "${key}" (allowed: ${TOP_LEVEL_KEYS.join(', ')})`);
    }
  }
  if (typeof raw.description !== 'string' || !raw.description.trim()) {
    throw new MetaError('meta: description is required and must be a non-empty string');
  }
  const meta: PlaybookMeta = { description: raw.description };
  if (raw.profile !== undefined) {
    if (typeof raw.profile !== 'string') throw new MetaError('meta: profile must be a string');
    meta.profile = raw.profile;
  }
  if (raw.startingPoint !== undefined) {
    if (typeof raw.startingPoint !== 'string') throw new MetaError('meta: startingPoint must be a string');
    meta.startingPoint = raw.startingPoint;
  }
  if (raw.experiments !== undefined) {
    if (typeof raw.experiments !== 'boolean') {
      throw new MetaError('meta: experiments must be a boolean (true enables all experiments for this run)');
    }
    meta.experiments = raw.experiments;
  }
  if (raw.permissions !== undefined) {
    if (!Array.isArray(raw.permissions) || raw.permissions.some(p => typeof p !== 'string')) {
      throw new MetaError('meta: permissions must be an array of strings');
    }
    meta.permissions = raw.permissions as string[];
  }
  if (raw.params !== undefined) {
    const params = raw.params;
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      throw new MetaError('meta: params must be an object');
    }
    const out: Record<string, PlaybookParamSpec> = {};
    for (const [name, specRaw] of Object.entries(params as Record<string, unknown>)) {
      if (typeof specRaw !== 'object' || specRaw === null || Array.isArray(specRaw)) {
        throw new MetaError(`meta: param "${name}" must be an object like { type: 'string', required: true }`);
      }
      const spec = specRaw as Record<string, unknown>;
      for (const key of Object.keys(spec)) {
        if (!PARAM_KEYS.includes(key)) {
          throw new MetaError(`meta: param "${name}" has unknown key "${key}" (allowed: ${PARAM_KEYS.join(', ')})`);
        }
      }
      if (typeof spec.type !== 'string' || !PARAM_TYPES.includes(spec.type)) {
        throw new MetaError(`meta: param "${name}" type must be one of ${PARAM_TYPES.join(', ')}`);
      }
      const parsed: PlaybookParamSpec = { type: spec.type as PlaybookParamSpec['type'] };
      if (spec.required !== undefined) {
        if (typeof spec.required !== 'boolean') throw new MetaError(`meta: param "${name}" required must be a boolean`);
        parsed.required = spec.required;
      }
      if (spec.description !== undefined) {
        if (typeof spec.description !== 'string') throw new MetaError(`meta: param "${name}" description must be a string`);
        parsed.description = spec.description;
      }
      out[name] = parsed;
    }
    meta.params = out;
  }
  return meta;
}

/** Parse `export const meta = {...}` from source WITHOUT executing it.
 *  Rejects computed keys, methods, spread, template interpolation, and the
 *  identifiers __proto__, constructor, prototype anywhere inside the literal. */
export function parseMeta(code: string): { meta?: PlaybookMeta; error?: string } {
  let ast: any;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch (e: any) {
    return { error: `could not parse the playbook file: ${e?.message ?? String(e)}` };
  }

  let init: any = null;
  for (const node of ast.body) {
    if (node.type !== 'ExportNamedDeclaration') continue;
    const decl = node.declaration;
    if (decl?.type !== 'VariableDeclaration') continue;
    for (const d of decl.declarations) {
      if (d.id?.type === 'Identifier' && d.id.name === 'meta') init = d.init;
    }
  }
  if (!init) {
    return { error: 'no `export const meta = {...}` found — every playbook must export a meta literal' };
  }
  if (init.type !== 'ObjectExpression') {
    return { error: 'meta must be an object literal — meta is parsed, never executed' };
  }

  try {
    return { meta: toMeta(objectValue(init, 'meta')) };
  } catch (e: any) {
    if (e instanceof MetaError) return { error: e.message };
    throw e;
  }
}
