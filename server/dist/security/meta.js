"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseMeta = parseMeta;
const acorn = __importStar(require("acorn"));
/** Keys that are never legal anywhere inside the meta literal. */
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];
const TOP_LEVEL_KEYS = ['description', 'params', 'profile', 'permissions', 'startingPoint', 'experiments'];
const PARAM_KEYS = ['type', 'required', 'description'];
const PARAM_TYPES = ['string', 'number', 'boolean'];
/** Thrown internally and converted to `{ error }` at the boundary. */
class MetaError extends Error {
}
/** Turn an AST node into a plain JS value, or throw MetaError. */
function literalValue(node, path) {
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
            return node.elements.map((el, i) => {
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
function objectValue(node, path) {
    const out = {};
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
        let key;
        if (prop.key.type === 'Identifier')
            key = prop.key.name;
        else if (prop.key.type === 'Literal' && typeof prop.key.value === 'string')
            key = prop.key.value;
        else
            throw new MetaError(`${path}: unsupported key type ${prop.key.type}`);
        if (FORBIDDEN_KEYS.includes(key)) {
            throw new MetaError(`${path}: forbidden key "${key}"`);
        }
        out[key] = literalValue(prop.value, `${path}.${key}`);
    }
    return out;
}
/** Shape-check the parsed object and narrow it to PlaybookMeta, or throw MetaError. */
function toMeta(raw) {
    for (const key of Object.keys(raw)) {
        if (!TOP_LEVEL_KEYS.includes(key)) {
            throw new MetaError(`meta: unknown key "${key}" (allowed: ${TOP_LEVEL_KEYS.join(', ')})`);
        }
    }
    if (typeof raw.description !== 'string' || !raw.description.trim()) {
        throw new MetaError('meta: description is required and must be a non-empty string');
    }
    const meta = { description: raw.description };
    if (raw.profile !== undefined) {
        if (typeof raw.profile !== 'string')
            throw new MetaError('meta: profile must be a string');
        meta.profile = raw.profile;
    }
    if (raw.startingPoint !== undefined) {
        if (typeof raw.startingPoint !== 'string')
            throw new MetaError('meta: startingPoint must be a string');
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
        meta.permissions = raw.permissions;
    }
    if (raw.params !== undefined) {
        const params = raw.params;
        if (typeof params !== 'object' || params === null || Array.isArray(params)) {
            throw new MetaError('meta: params must be an object');
        }
        const out = {};
        for (const [name, specRaw] of Object.entries(params)) {
            if (typeof specRaw !== 'object' || specRaw === null || Array.isArray(specRaw)) {
                throw new MetaError(`meta: param "${name}" must be an object like { type: 'string', required: true }`);
            }
            const spec = specRaw;
            for (const key of Object.keys(spec)) {
                if (!PARAM_KEYS.includes(key)) {
                    throw new MetaError(`meta: param "${name}" has unknown key "${key}" (allowed: ${PARAM_KEYS.join(', ')})`);
                }
            }
            if (typeof spec.type !== 'string' || !PARAM_TYPES.includes(spec.type)) {
                throw new MetaError(`meta: param "${name}" type must be one of ${PARAM_TYPES.join(', ')}`);
            }
            const parsed = { type: spec.type };
            if (spec.required !== undefined) {
                if (typeof spec.required !== 'boolean')
                    throw new MetaError(`meta: param "${name}" required must be a boolean`);
                parsed.required = spec.required;
            }
            if (spec.description !== undefined) {
                if (typeof spec.description !== 'string')
                    throw new MetaError(`meta: param "${name}" description must be a string`);
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
function parseMeta(code) {
    let ast;
    try {
        ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
    }
    catch (e) {
        return { error: `could not parse the playbook file: ${e?.message ?? String(e)}` };
    }
    let init = null;
    for (const node of ast.body) {
        if (node.type !== 'ExportNamedDeclaration')
            continue;
        const decl = node.declaration;
        if (decl?.type !== 'VariableDeclaration')
            continue;
        for (const d of decl.declarations) {
            if (d.id?.type === 'Identifier' && d.id.name === 'meta')
                init = d.init;
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
    }
    catch (e) {
        if (e instanceof MetaError)
            return { error: e.message };
        throw e;
    }
}
//# sourceMappingURL=meta.js.map