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
/** One declared parameter of a playbook. */
export interface PlaybookParamSpec {
    type: 'string' | 'number' | 'boolean';
    required?: boolean;
    description?: string;
}
/** The `meta` object a playbook file exports. */
export interface PlaybookMeta {
    description: string;
    params?: Record<string, PlaybookParamSpec>;
    profile?: string;
    permissions?: string[];
    startingPoint?: string;
    /** Addendum B. `true` enables every name in AVAILABLE_EXPERIMENTS for this
     *  run's session only; `false`/absent inherits the resolved config unchanged.
     *  Top level on purpose — permissions are a security boundary, experiments are
     *  a behavioral dependency. A boolean, never a list of names: a list rots when
     *  an experiment graduates and its toggle leaves AVAILABLE_EXPERIMENTS.
     *  Plan 2 only parses and type-checks it. ACTIVATION is Plan 3's — that is
     *  where the ConnectionManager lives. Do not build it here. */
    experiments?: boolean;
}
/** Parse `export const meta = {...}` from source WITHOUT executing it.
 *  Rejects computed keys, methods, spread, template interpolation, and the
 *  identifiers __proto__, constructor, prototype anywhere inside the literal. */
export declare function parseMeta(code: string): {
    meta?: PlaybookMeta;
    error?: string;
};
//# sourceMappingURL=meta.d.ts.map