# v2.0.0 Config Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SuperSurf's scattered configuration (env vars, hardcoded defaults, MCP `experimental_features` tool) with a single 3-layer ConfigService (CLI flag → env var → JSON file → hardcoded defaults), retire the agent-facing `experimental_features` MCP tool, and rename `AuditLogger` → `UsageMetricsLogger`. Ship as v2.0.0.

**Architecture:** A `ConfigService` class lives in the `shared/` workspace package so both daemon and server consume one source of truth. It loads a JSON file from `~/.supersurf/config.json` (auto-scaffolded on first daemon startup with all defaults filled), overlays env vars, then CLI flags from the server process. Every resolver uses a `??` chain so unset values from upper layers fall through cleanly. Existing config sites (ExperimentRegistry, secure_eval init, AuditLogger, domain whitelist, daemon port) are migrated to read from ConfigService.

**Tech Stack:** TypeScript (strict), Node.js built-ins only in `shared/`, Vitest for tests. No new runtime dependencies.

---

## Scope & Non-Goals

**In scope:**
- New `shared/config/` module (ConfigService + types + loaders + scaffold)
- Migrate existing config readers to ConfigService
- Delete `experimental_features` MCP tool + `onExperimentalFeatures` handler
- Rename `AuditLogger` → `UsageMetricsLogger` (file path: `audit-*.ndjson` → `metrics-*.ndjson`)
- Update `.claude/skills/usage-data-audit/` skill in the same commit as the rename
- Update `CLAUDE.md` audit/AuditLogger references
- Version bump to v2.0.0 + CHANGELOG entry

**Not in scope (deferred to sticky note `supersurf-update-config-tool` v2):**
- Agent-facing dynamic config mutation tool
- Hot-reload of `config.json` (changes require restart)
- Config schema validation library (we hand-roll a tiny validator)

---

## Config Shape (Decided)

```typescript
// shared/config/types.ts
export interface Config {
  experiments: {
    page_diffing: boolean;
    smart_waiting: boolean;
    storage_inspection: boolean;
    mouse_humanization: boolean;
  };
  security: {
    secure_eval: boolean;
    domain_whitelist: {
      enabled: boolean;
      mode: 'tranco' | 'custom' | 'both';
      custom: string[];
    };
  };
  daemon: {
    port: number;
    idle_timeout_ms: number;
  };
  logging: {
    debug: boolean;
    usage_metrics: boolean;
  };
  tips: boolean;
}
```

## Hardcoded Defaults (System fallback)

```typescript
// shared/config/defaults.ts
export const HARDCODED_DEFAULTS: Config = {
  experiments: {
    page_diffing: false,
    smart_waiting: false,
    storage_inspection: false,
    mouse_humanization: false,
  },
  security: {
    secure_eval: true,
    domain_whitelist: {
      enabled: false,
      mode: 'tranco',
      custom: [],
    },
  },
  daemon: {
    port: 5555,
    idle_timeout_ms: 10 * 60 * 1000,
  },
  logging: {
    debug: false,
    usage_metrics: false, // system default — scaffolded config flips this to true
  },
  tips: true,
};
```

## Scaffolded Config (Written to disk on first run)

Identical to `HARDCODED_DEFAULTS` **except** `logging.usage_metrics: true`. Rationale: when an operator has a real config file, opt them into telemetry by default (they can edit to disable); when no file exists at all, default off.

## Env Var Surface

| Env Var | Maps to | Notes |
|---------|---------|-------|
| `SUPERSURF_CONFIG_FILE` | (path override) | Alternative JSON path. Default: `~/.supersurf/config.json` |
| `SUPERSURF_PORT` | `daemon.port` | |
| `SUPERSURF_DISABLE_SECURE_EVAL` | `security.secure_eval` | Truthy → `false` |
| `SUPERSURF_DEBUG` | `logging.debug` | Truthy → `true`, also `'no_truncate'` accepted |
| `SUPERSURF_EXPERIMENTS` | `experiments.*` | Comma-list of experiment names to enable |

## CLI Flag Surface

| Flag | Maps to |
|------|---------|
| `--port <n>` | `daemon.port` |
| `--debug [mode]` | `logging.debug` |
| `--disable-secure-eval` | `security.secure_eval` |

`--log-file` and `--script-mode` and `--child` are runtime flags, not config — they stay on the CLI only.

## Resolution Precedence (per leaf)

```
CLI flag (if provided)
  ?? env var (if set)
    ?? JSON config value
      ?? hardcoded default
```

---

## File Structure

**New files:**
```
shared/config/
  index.ts        # Barrel: exports ConfigService, Config type
  types.ts        # Config interface, PartialConfig helper, ConfigSource type
  defaults.ts     # HARDCODED_DEFAULTS, SCAFFOLD_DEFAULTS
  loaders.ts      # loadJsonConfig(path), loadEnvConfig(env)
  service.ts      # ConfigService class — owns merge + resolution
  scaffold.ts     # ensureConfigFile(path) — writes SCAFFOLD_DEFAULTS if missing
```

**Modified files:**
- `shared/index.ts` — re-export ConfigService + Config type
- `shared/package.json` — bump to 2.0.0 (handled by version.bump)
- `daemon/src/main.ts` — call `ensureConfigFile()` on startup, instantiate ConfigService, log resolution source for each value
- `daemon/src/extension-bridge.ts` — read `daemon.port` from ConfigService instead of CLI arg
- `daemon/src/main.ts` — read `daemon.idle_timeout_ms` from ConfigService
- `daemon/src/experiments/index.ts` — read experiment defaults from ConfigService (replaces `SUPERSURF_EXPERIMENTS` parsing)
- `server/src/cli.ts` — pass CLI flags into ConfigService, replace hardcoded defaults in `resolveConfig`
- `server/src/backend.ts` — instantiate `UsageMetricsLogger` (renamed), respect `logging.usage_metrics`
- `server/src/backend/schemas.ts` — **delete** `experimental_features` schema
- `server/src/backend/handlers.ts` — **delete** `onExperimentalFeatures`, `experimental_features` switch case
- `server/src/experimental/index.ts` — `applyInitialState` reads from ConfigService instead of receiving args
- `server/src/tools/browser_evaluate/index.ts` — read `security.secure_eval` from ConfigService
- `server/src/tools/lib/dispatcher.ts` — gate tip rendering on `tips` from ConfigService
- `server/src/audit-logger.ts` → renamed to `server/src/usage-metrics-logger.ts` (class `AuditLogger` → `UsageMetricsLogger`, file prefix `audit-` → `metrics-`)
- `server/src/tools/lib/dispatcher.ts` — type import updates
- `server/src/tools.ts` — type import updates
- `server/src/backend/types.ts` — type import updates
- `extension/src/domain-whitelist.ts` — read whitelist shape from a message passed by daemon/server (extension doesn't read disk; daemon pushes config snapshot)
- `.claude/skills/usage-data-audit/SKILL.md` — glob `metrics-*.ndjson`, reference `server/src/usage-metrics-logger.ts`
- `.claude/skills/usage-data-audit/LEGEND.md` — wording sweep
- `CLAUDE.md` — audit-logger references swept, `experimental_features` removed from backend tools list
- `CHANGELOG.md` — v2.0.0 entry
- `server/tests/audit-logger.test.ts` → renamed `server/tests/usage-metrics-logger.test.ts`
- `server/tests/backend.test.ts` — remove `experimental_features` dispatch test
- New: `shared/tests/config.test.ts`

---

## Task Decomposition

### Phase 1: ConfigService Foundation (shared/)

### Task 1: Config types

**Files:**
- Create: `shared/config/types.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// shared/tests/config.types.test.ts
import { describe, it, expectTypeOf } from 'vitest';
import type { Config, PartialConfig, ConfigSource } from '../config/types';

describe('config types', () => {
  it('Config has 5 top-level sections', () => {
    expectTypeOf<Config>().toHaveProperty('experiments');
    expectTypeOf<Config>().toHaveProperty('security');
    expectTypeOf<Config>().toHaveProperty('daemon');
    expectTypeOf<Config>().toHaveProperty('logging');
    expectTypeOf<Config>().toHaveProperty('tips');
  });

  it('PartialConfig allows any subset', () => {
    const p: PartialConfig = { daemon: { port: 1234 } };
    expectTypeOf(p).toMatchTypeOf<PartialConfig>();
  });

  it('ConfigSource enumerates 4 layers', () => {
    expectTypeOf<ConfigSource>().toEqualTypeOf<'cli' | 'env' | 'file' | 'default'>();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix shared test -- config.types`
Expected: FAIL — `Cannot find module '../config/types'`

- [ ] **Step 3: Write the types**

```typescript
// shared/config/types.ts
export interface Config {
  experiments: {
    page_diffing: boolean;
    smart_waiting: boolean;
    storage_inspection: boolean;
    mouse_humanization: boolean;
  };
  security: {
    secure_eval: boolean;
    domain_whitelist: {
      enabled: boolean;
      mode: 'tranco' | 'custom' | 'both';
      custom: string[];
    };
  };
  daemon: {
    port: number;
    idle_timeout_ms: number;
  };
  logging: {
    debug: boolean;
    usage_metrics: boolean;
  };
  tips: boolean;
}

export type PartialConfig = {
  experiments?: Partial<Config['experiments']>;
  security?: {
    secure_eval?: boolean;
    domain_whitelist?: Partial<Config['security']['domain_whitelist']>;
  };
  daemon?: Partial<Config['daemon']>;
  logging?: Partial<Config['logging']>;
  tips?: boolean;
};

export type ConfigSource = 'cli' | 'env' | 'file' | 'default';
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm --prefix shared test -- config.types`
Expected: PASS

- [ ] **Step 5: Commit (no commit — bundled at end of phase per project convention)**

Skip commit until Phase 1 closes. We commit phase-by-phase to keep the history readable.

---

### Task 2: Hardcoded + Scaffold defaults

**Files:**
- Create: `shared/config/defaults.ts`
- Create: `shared/tests/config.defaults.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// shared/tests/config.defaults.test.ts
import { describe, it, expect } from 'vitest';
import { HARDCODED_DEFAULTS, SCAFFOLD_DEFAULTS } from '../config/defaults';

describe('config defaults', () => {
  it('HARDCODED_DEFAULTS has secure_eval on, usage_metrics off', () => {
    expect(HARDCODED_DEFAULTS.security.secure_eval).toBe(true);
    expect(HARDCODED_DEFAULTS.logging.usage_metrics).toBe(false);
  });

  it('HARDCODED_DEFAULTS has all experiments off', () => {
    expect(HARDCODED_DEFAULTS.experiments.page_diffing).toBe(false);
    expect(HARDCODED_DEFAULTS.experiments.smart_waiting).toBe(false);
    expect(HARDCODED_DEFAULTS.experiments.storage_inspection).toBe(false);
    expect(HARDCODED_DEFAULTS.experiments.mouse_humanization).toBe(false);
  });

  it('HARDCODED_DEFAULTS port is 5555', () => {
    expect(HARDCODED_DEFAULTS.daemon.port).toBe(5555);
  });

  it('HARDCODED_DEFAULTS tips on, debug off', () => {
    expect(HARDCODED_DEFAULTS.tips).toBe(true);
    expect(HARDCODED_DEFAULTS.logging.debug).toBe(false);
  });

  it('SCAFFOLD_DEFAULTS flips usage_metrics on', () => {
    expect(SCAFFOLD_DEFAULTS.logging.usage_metrics).toBe(true);
  });

  it('SCAFFOLD_DEFAULTS otherwise matches HARDCODED_DEFAULTS', () => {
    const cloneNoMetrics = JSON.parse(JSON.stringify(SCAFFOLD_DEFAULTS));
    cloneNoMetrics.logging.usage_metrics = false;
    expect(cloneNoMetrics).toEqual(HARDCODED_DEFAULTS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix shared test -- config.defaults`
Expected: FAIL — module not found

- [ ] **Step 3: Write defaults**

```typescript
// shared/config/defaults.ts
import type { Config } from './types';

export const HARDCODED_DEFAULTS: Config = {
  experiments: {
    page_diffing: false,
    smart_waiting: false,
    storage_inspection: false,
    mouse_humanization: false,
  },
  security: {
    secure_eval: true,
    domain_whitelist: {
      enabled: false,
      mode: 'tranco',
      custom: [],
    },
  },
  daemon: {
    port: 5555,
    idle_timeout_ms: 10 * 60 * 1000,
  },
  logging: {
    debug: false,
    usage_metrics: false,
  },
  tips: true,
};

export const SCAFFOLD_DEFAULTS: Config = {
  ...HARDCODED_DEFAULTS,
  experiments: { ...HARDCODED_DEFAULTS.experiments },
  security: {
    ...HARDCODED_DEFAULTS.security,
    domain_whitelist: { ...HARDCODED_DEFAULTS.security.domain_whitelist, custom: [] },
  },
  daemon: { ...HARDCODED_DEFAULTS.daemon },
  logging: { ...HARDCODED_DEFAULTS.logging, usage_metrics: true },
};
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm --prefix shared test -- config.defaults`
Expected: PASS

---

### Task 3: JSON loader (resilient: malformed → defaults + warn)

**Files:**
- Create: `shared/config/loaders.ts` (JSON loader portion)
- Create: `shared/tests/config.loaders-json.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// shared/tests/config.loaders-json.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadJsonConfig } from '../config/loaders';

let tmpDir: string;
let warns: string[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  warns = [];
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('loadJsonConfig', () => {
  it('returns empty + no warning when file missing', () => {
    const { config, warnings } = loadJsonConfig(path.join(tmpDir, 'absent.json'));
    expect(config).toEqual({});
    expect(warnings).toEqual([]);
  });

  it('returns parsed object for valid JSON', () => {
    const p = path.join(tmpDir, 'c.json');
    fs.writeFileSync(p, JSON.stringify({ daemon: { port: 6666 } }));
    const { config, warnings } = loadJsonConfig(p);
    expect(config).toEqual({ daemon: { port: 6666 } });
    expect(warnings).toEqual([]);
  });

  it('returns empty + warning when JSON is malformed', () => {
    const p = path.join(tmpDir, 'broken.json');
    fs.writeFileSync(p, '{not valid');
    const { config, warnings } = loadJsonConfig(p);
    expect(config).toEqual({});
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/malformed/i);
  });

  it('returns empty + warning when file is not an object', () => {
    const p = path.join(tmpDir, 'arr.json');
    fs.writeFileSync(p, '[1,2,3]');
    const { config, warnings } = loadJsonConfig(p);
    expect(config).toEqual({});
    expect(warnings[0]).toMatch(/object/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix shared test -- config.loaders-json`
Expected: FAIL — module not found

- [ ] **Step 3: Write the JSON loader**

```typescript
// shared/config/loaders.ts
import * as fs from 'fs';
import type { PartialConfig } from './types';

export interface LoadResult {
  config: PartialConfig;
  warnings: string[];
}

export function loadJsonConfig(filePath: string): LoadResult {
  if (!fs.existsSync(filePath)) {
    return { config: {}, warnings: [] };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: any) {
    return { config: {}, warnings: [`config: failed to read ${filePath}: ${err.message}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    return {
      config: {},
      warnings: [`config: malformed JSON in ${filePath} — using defaults (${err.message})`],
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      config: {},
      warnings: [`config: ${filePath} must be a JSON object — using defaults`],
    };
  }
  return { config: parsed as PartialConfig, warnings: [] };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm --prefix shared test -- config.loaders-json`
Expected: PASS (4 tests)

---

### Task 4: Env loader

**Files:**
- Modify: `shared/config/loaders.ts` (add env loader)
- Create: `shared/tests/config.loaders-env.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// shared/tests/config.loaders-env.test.ts
import { describe, it, expect } from 'vitest';
import { loadEnvConfig } from '../config/loaders';

describe('loadEnvConfig', () => {
  it('returns empty when no SUPERSURF_* vars set', () => {
    const { config, warnings } = loadEnvConfig({});
    expect(config).toEqual({});
    expect(warnings).toEqual([]);
  });

  it('maps SUPERSURF_PORT to daemon.port', () => {
    const { config } = loadEnvConfig({ SUPERSURF_PORT: '8080' });
    expect(config.daemon?.port).toBe(8080);
  });

  it('warns + skips when SUPERSURF_PORT is not numeric', () => {
    const { config, warnings } = loadEnvConfig({ SUPERSURF_PORT: 'abc' });
    expect(config.daemon?.port).toBeUndefined();
    expect(warnings[0]).toMatch(/SUPERSURF_PORT/);
  });

  it('maps SUPERSURF_DISABLE_SECURE_EVAL=1 to security.secure_eval=false', () => {
    const { config } = loadEnvConfig({ SUPERSURF_DISABLE_SECURE_EVAL: '1' });
    expect(config.security?.secure_eval).toBe(false);
  });

  it('maps SUPERSURF_DEBUG=1 to logging.debug=true', () => {
    const { config } = loadEnvConfig({ SUPERSURF_DEBUG: '1' });
    expect(config.logging?.debug).toBe(true);
  });

  it('parses SUPERSURF_EXPERIMENTS comma list', () => {
    const { config } = loadEnvConfig({
      SUPERSURF_EXPERIMENTS: 'page_diffing,smart_waiting',
    });
    expect(config.experiments?.page_diffing).toBe(true);
    expect(config.experiments?.smart_waiting).toBe(true);
    expect(config.experiments?.mouse_humanization).toBeUndefined();
  });

  it('warns on unknown experiment names but accepts known ones', () => {
    const { config, warnings } = loadEnvConfig({
      SUPERSURF_EXPERIMENTS: 'page_diffing,bogus,smart_waiting',
    });
    expect(config.experiments?.page_diffing).toBe(true);
    expect(config.experiments?.smart_waiting).toBe(true);
    expect(warnings[0]).toMatch(/bogus/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix shared test -- config.loaders-env`
Expected: FAIL — `loadEnvConfig is not exported`

- [ ] **Step 3: Add env loader**

Append to `shared/config/loaders.ts`:

```typescript
const KNOWN_EXPERIMENTS = [
  'page_diffing',
  'smart_waiting',
  'storage_inspection',
  'mouse_humanization',
] as const;

function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.toLowerCase().trim();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export function loadEnvConfig(env: Record<string, string | undefined>): LoadResult {
  const out: PartialConfig = {};
  const warnings: string[] = [];

  if (env.SUPERSURF_PORT !== undefined) {
    const n = Number(env.SUPERSURF_PORT);
    if (!Number.isFinite(n) || n <= 0 || n > 65535) {
      warnings.push(`config: SUPERSURF_PORT=${env.SUPERSURF_PORT} is not a valid port — ignored`);
    } else {
      out.daemon = { ...(out.daemon || {}), port: n };
    }
  }

  if (isTruthy(env.SUPERSURF_DISABLE_SECURE_EVAL)) {
    out.security = { ...(out.security || {}), secure_eval: false };
  }

  if (env.SUPERSURF_DEBUG !== undefined) {
    out.logging = { ...(out.logging || {}), debug: isTruthy(env.SUPERSURF_DEBUG) || env.SUPERSURF_DEBUG === 'no_truncate' };
  }

  if (env.SUPERSURF_EXPERIMENTS) {
    const names = env.SUPERSURF_EXPERIMENTS.split(',').map(s => s.trim()).filter(Boolean);
    const expOut: Partial<Config['experiments']> = {};
    for (const name of names) {
      if ((KNOWN_EXPERIMENTS as readonly string[]).includes(name)) {
        (expOut as any)[name] = true;
      } else {
        warnings.push(`config: SUPERSURF_EXPERIMENTS contains unknown name "${name}" — ignored`);
      }
    }
    if (Object.keys(expOut).length > 0) {
      out.experiments = { ...(out.experiments || {}), ...expOut };
    }
  }

  return { config: out, warnings };
}
```

Also add the `Config` import at the top of `loaders.ts`:
```typescript
import type { Config, PartialConfig } from './types';
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm --prefix shared test -- config.loaders-env`
Expected: PASS (7 tests)

---

### Task 5: ConfigService (merge + resolution)

**Files:**
- Create: `shared/config/service.ts`
- Create: `shared/tests/config.service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// shared/tests/config.service.test.ts
import { describe, it, expect } from 'vitest';
import { ConfigService } from '../config/service';
import { HARDCODED_DEFAULTS } from '../config/defaults';

describe('ConfigService', () => {
  it('returns hardcoded defaults when no overrides', () => {
    const s = new ConfigService({ cli: {}, env: {}, file: {} });
    expect(s.get()).toEqual(HARDCODED_DEFAULTS);
  });

  it('file overrides default', () => {
    const s = new ConfigService({ cli: {}, env: {}, file: { daemon: { port: 7000 } } });
    expect(s.get().daemon.port).toBe(7000);
    expect(s.get().daemon.idle_timeout_ms).toBe(HARDCODED_DEFAULTS.daemon.idle_timeout_ms);
  });

  it('env overrides file', () => {
    const s = new ConfigService({
      cli: {},
      env: { daemon: { port: 8000 } },
      file: { daemon: { port: 7000 } },
    });
    expect(s.get().daemon.port).toBe(8000);
  });

  it('cli overrides env', () => {
    const s = new ConfigService({
      cli: { daemon: { port: 9000 } },
      env: { daemon: { port: 8000 } },
      file: { daemon: { port: 7000 } },
    });
    expect(s.get().daemon.port).toBe(9000);
  });

  it('partial sections fall through per leaf', () => {
    const s = new ConfigService({
      cli: {},
      env: { logging: { debug: true } },
      file: { logging: { usage_metrics: true } },
    });
    expect(s.get().logging.debug).toBe(true);
    expect(s.get().logging.usage_metrics).toBe(true);
  });

  it('reports source for each leaf', () => {
    const s = new ConfigService({
      cli: { daemon: { port: 9000 } },
      env: { logging: { debug: true } },
      file: { security: { secure_eval: false } },
    });
    expect(s.sourceOf('daemon.port')).toBe('cli');
    expect(s.sourceOf('logging.debug')).toBe('env');
    expect(s.sourceOf('security.secure_eval')).toBe('file');
    expect(s.sourceOf('tips')).toBe('default');
  });

  it('warns on unknown top-level key in file', () => {
    const warns: string[] = [];
    const s = new ConfigService({
      cli: {},
      env: {},
      file: { bogus: 1 } as any,
      onWarn: (m) => warns.push(m),
    });
    expect(warns[0]).toMatch(/bogus/);
    expect(s.get()).toEqual(HARDCODED_DEFAULTS);
  });

  it('warns on wrong type and falls back to default', () => {
    const warns: string[] = [];
    const s = new ConfigService({
      cli: {},
      env: {},
      file: { daemon: { port: 'abc' as any } },
      onWarn: (m) => warns.push(m),
    });
    expect(warns[0]).toMatch(/daemon\.port/);
    expect(s.get().daemon.port).toBe(HARDCODED_DEFAULTS.daemon.port);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix shared test -- config.service`
Expected: FAIL — module not found

- [ ] **Step 3: Write the ConfigService**

```typescript
// shared/config/service.ts
import type { Config, PartialConfig, ConfigSource } from './types';
import { HARDCODED_DEFAULTS } from './defaults';

export interface ConfigInputs {
  cli: PartialConfig;
  env: PartialConfig;
  file: PartialConfig;
  onWarn?: (msg: string) => void;
}

type LeafPath = string;

export class ConfigService {
  private resolved: Config;
  private sources: Map<LeafPath, ConfigSource> = new Map();

  constructor(inputs: ConfigInputs) {
    const warn = inputs.onWarn ?? (() => {});
    this.validateKnownKeys(inputs.file, warn);
    this.resolved = this.merge(inputs, warn);
  }

  get(): Config {
    return this.resolved;
  }

  sourceOf(path: LeafPath): ConfigSource {
    return this.sources.get(path) ?? 'default';
  }

  private validateKnownKeys(file: PartialConfig, warn: (m: string) => void) {
    const known = new Set(Object.keys(HARDCODED_DEFAULTS));
    for (const k of Object.keys(file)) {
      if (!known.has(k)) warn(`config: unknown top-level key "${k}" — ignored`);
    }
  }

  private pick<T>(
    leafPath: LeafPath,
    cli: T | undefined,
    env: T | undefined,
    file: T | undefined,
    fallback: T,
    typeCheck: (v: unknown) => v is T,
    warn: (m: string) => void,
  ): T {
    const check = (v: T | undefined, src: ConfigSource): T | undefined => {
      if (v === undefined) return undefined;
      if (!typeCheck(v)) {
        warn(`config: ${leafPath} from ${src} has wrong type — falling back`);
        return undefined;
      }
      this.sources.set(leafPath, src);
      return v;
    };
    const fromCli = check(cli, 'cli');
    if (fromCli !== undefined) return fromCli;
    const fromEnv = check(env, 'env');
    if (fromEnv !== undefined) return fromEnv;
    const fromFile = check(file, 'file');
    if (fromFile !== undefined) return fromFile;
    this.sources.set(leafPath, 'default');
    return fallback;
  }

  private merge(inp: ConfigInputs, warn: (m: string) => void): Config {
    const D = HARDCODED_DEFAULTS;
    const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
    const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
    const isMode = (v: unknown): v is 'tranco' | 'custom' | 'both' =>
      v === 'tranco' || v === 'custom' || v === 'both';

    const pick = this.pick.bind(this);

    return {
      experiments: {
        page_diffing: pick('experiments.page_diffing',
          inp.cli.experiments?.page_diffing, inp.env.experiments?.page_diffing,
          inp.file.experiments?.page_diffing, D.experiments.page_diffing, isBool, warn),
        smart_waiting: pick('experiments.smart_waiting',
          inp.cli.experiments?.smart_waiting, inp.env.experiments?.smart_waiting,
          inp.file.experiments?.smart_waiting, D.experiments.smart_waiting, isBool, warn),
        storage_inspection: pick('experiments.storage_inspection',
          inp.cli.experiments?.storage_inspection, inp.env.experiments?.storage_inspection,
          inp.file.experiments?.storage_inspection, D.experiments.storage_inspection, isBool, warn),
        mouse_humanization: pick('experiments.mouse_humanization',
          inp.cli.experiments?.mouse_humanization, inp.env.experiments?.mouse_humanization,
          inp.file.experiments?.mouse_humanization, D.experiments.mouse_humanization, isBool, warn),
      },
      security: {
        secure_eval: pick('security.secure_eval',
          inp.cli.security?.secure_eval, inp.env.security?.secure_eval,
          inp.file.security?.secure_eval, D.security.secure_eval, isBool, warn),
        domain_whitelist: {
          enabled: pick('security.domain_whitelist.enabled',
            inp.cli.security?.domain_whitelist?.enabled,
            inp.env.security?.domain_whitelist?.enabled,
            inp.file.security?.domain_whitelist?.enabled,
            D.security.domain_whitelist.enabled, isBool, warn),
          mode: pick('security.domain_whitelist.mode',
            inp.cli.security?.domain_whitelist?.mode,
            inp.env.security?.domain_whitelist?.mode,
            inp.file.security?.domain_whitelist?.mode,
            D.security.domain_whitelist.mode, isMode, warn),
          custom: pick('security.domain_whitelist.custom',
            inp.cli.security?.domain_whitelist?.custom,
            inp.env.security?.domain_whitelist?.custom,
            inp.file.security?.domain_whitelist?.custom,
            D.security.domain_whitelist.custom, isStrArr, warn),
        },
      },
      daemon: {
        port: pick('daemon.port',
          inp.cli.daemon?.port, inp.env.daemon?.port,
          inp.file.daemon?.port, D.daemon.port, isNum, warn),
        idle_timeout_ms: pick('daemon.idle_timeout_ms',
          inp.cli.daemon?.idle_timeout_ms, inp.env.daemon?.idle_timeout_ms,
          inp.file.daemon?.idle_timeout_ms, D.daemon.idle_timeout_ms, isNum, warn),
      },
      logging: {
        debug: pick('logging.debug',
          inp.cli.logging?.debug, inp.env.logging?.debug,
          inp.file.logging?.debug, D.logging.debug, isBool, warn),
        usage_metrics: pick('logging.usage_metrics',
          inp.cli.logging?.usage_metrics, inp.env.logging?.usage_metrics,
          inp.file.logging?.usage_metrics, D.logging.usage_metrics, isBool, warn),
      },
      tips: pick('tips', inp.cli.tips, inp.env.tips, inp.file.tips, D.tips, isBool, warn),
    };
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm --prefix shared test -- config.service`
Expected: PASS (8 tests)

---

### Task 6: Scaffold writer

**Files:**
- Create: `shared/config/scaffold.ts`
- Create: `shared/tests/config.scaffold.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// shared/tests/config.scaffold.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureConfigFile } from '../config/scaffold';
import { SCAFFOLD_DEFAULTS } from '../config/defaults';

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaf-')); });
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('ensureConfigFile', () => {
  it('creates file with SCAFFOLD_DEFAULTS when missing', () => {
    const p = path.join(tmpDir, 'sub', 'config.json');
    const result = ensureConfigFile(p);
    expect(result.created).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    expect(parsed).toEqual(SCAFFOLD_DEFAULTS);
  });

  it('leaves existing file untouched', () => {
    const p = path.join(tmpDir, 'config.json');
    fs.writeFileSync(p, JSON.stringify({ daemon: { port: 1111 } }));
    const result = ensureConfigFile(p);
    expect(result.created).toBe(false);
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    expect(parsed).toEqual({ daemon: { port: 1111 } });
  });

  it('creates intermediate directories', () => {
    const p = path.join(tmpDir, 'a', 'b', 'c', 'config.json');
    ensureConfigFile(p);
    expect(fs.existsSync(p)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix shared test -- config.scaffold`
Expected: FAIL — module not found

- [ ] **Step 3: Write the scaffold**

```typescript
// shared/config/scaffold.ts
import * as fs from 'fs';
import * as path from 'path';
import { SCAFFOLD_DEFAULTS } from './defaults';

export interface ScaffoldResult {
  created: boolean;
  path: string;
}

export function ensureConfigFile(filePath: string): ScaffoldResult {
  if (fs.existsSync(filePath)) {
    return { created: false, path: filePath };
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(SCAFFOLD_DEFAULTS, null, 2) + '\n', 'utf-8');
  return { created: true, path: filePath };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm --prefix shared test -- config.scaffold`
Expected: PASS (3 tests)

---

### Task 7: Shared barrel export + build

**Files:**
- Create: `shared/config/index.ts`
- Modify: `shared/index.ts`

- [ ] **Step 1: Write barrel**

```typescript
// shared/config/index.ts
export { ConfigService } from './service';
export type { ConfigInputs } from './service';
export type { Config, PartialConfig, ConfigSource } from './types';
export { HARDCODED_DEFAULTS, SCAFFOLD_DEFAULTS } from './defaults';
export { loadJsonConfig, loadEnvConfig } from './loaders';
export type { LoadResult } from './loaders';
export { ensureConfigFile } from './scaffold';
export type { ScaffoldResult } from './scaffold';
```

- [ ] **Step 2: Update shared/index.ts**

Replace the entire `shared/index.ts` with:

```typescript
export { FileLogger, LOG_ROOT, sanitizeFilename, truncateString, replacer } from './logger/logger';
export type { DebugMode } from './logger/logger';

export {
  ConfigService,
  HARDCODED_DEFAULTS,
  SCAFFOLD_DEFAULTS,
  loadJsonConfig,
  loadEnvConfig,
  ensureConfigFile,
} from './config/index';
export type {
  Config,
  PartialConfig,
  ConfigSource,
  ConfigInputs,
  LoadResult,
  ScaffoldResult,
} from './config/index';
```

- [ ] **Step 3: Build shared**

Run: `npm run build.shared`
Expected: success — outputs to `shared/dist/`

- [ ] **Step 4: Run all shared tests**

Run: `npm --prefix shared test`
Expected: all config tests + existing logger tests pass

- [ ] **Step 5: Commit Phase 1**

Stage:
```bash
git add shared/config shared/tests/config* shared/index.ts shared/dist
```
Commit message:
```
feat(shared): ConfigService — 3-layer (CLI > env > JSON > defaults) resolution
```

---

### Phase 2: Wire into daemon

### Task 8: Daemon scaffolds + instantiates ConfigService

**Files:**
- Modify: `daemon/src/main.ts`
- Modify: `daemon/tests/main.test.ts`

- [ ] **Step 1: Read daemon main.ts to find CLI parse + startup**

Read `daemon/src/main.ts` and locate the entry block (the part that handles `start` / `stop` / `restart` and reads CLI args).

- [ ] **Step 2: Identify the port + idle-timeout sites**

Note the line numbers where `5555` and `10 * 60 * 1000` are referenced. These are the two values we'll switch to ConfigService.

- [ ] **Step 3: Add scaffold + ConfigService at startup**

In `daemon/src/main.ts`, near the top of the `start` action (after CLI flags are parsed, before WebSocket / Unix socket creation), insert:

```typescript
import * as path from 'path';
import * as os from 'os';
import {
  ConfigService,
  ensureConfigFile,
  loadJsonConfig,
  loadEnvConfig,
} from 'shared';

const configPath = process.env.SUPERSURF_CONFIG_FILE
  || path.join(os.homedir(), '.supersurf', 'config.json');
const scaffold = ensureConfigFile(configPath);
if (scaffold.created) {
  console.log(`[daemon] Scaffolded default config at ${configPath}`);
}
const { config: fileCfg, warnings: fileWarn } = loadJsonConfig(configPath);
const { config: envCfg, warnings: envWarn } = loadEnvConfig(process.env);
for (const w of [...fileWarn, ...envWarn]) console.warn(`[daemon] ${w}`);
const cfg = new ConfigService({
  cli: {},
  env: envCfg,
  file: fileCfg,
  onWarn: (m) => console.warn(`[daemon] ${m}`),
});
```

Then replace the existing port literal with `cfg.get().daemon.port` and the existing idle timeout literal with `cfg.get().daemon.idle_timeout_ms`. Pass `cfg` into the extension-bridge constructor (next task).

- [ ] **Step 4: Update existing daemon test**

In `daemon/tests/main.test.ts`, if any test asserts the hardcoded 5555 default, change it to read from `HARDCODED_DEFAULTS.daemon.port`. Import:
```typescript
import { HARDCODED_DEFAULTS } from 'shared';
```

- [ ] **Step 5: Build + run daemon tests**

Run: `npm run build.shared && npm run build.daemon && npm --prefix daemon test`
Expected: all pass

---

### Task 9: Daemon experiment defaults come from ConfigService

**Files:**
- Modify: `daemon/src/experiments/index.ts`
- Modify: `daemon/tests/experiments.test.ts`

- [ ] **Step 1: Read current experiment defaults logic**

Read `daemon/src/experiments/index.ts`. Find where `SUPERSURF_EXPERIMENTS` is parsed for defaults.

- [ ] **Step 2: Replace env parse with ConfigService injection**

Change the registry constructor (or factory) to accept a `Config['experiments']` snapshot, and seed the default-enabled set from those booleans. Remove the in-file `process.env.SUPERSURF_EXPERIMENTS` parse — the daemon entry now passes config in.

- [ ] **Step 3: Update existing tests**

In `daemon/tests/experiments.test.ts`, replace any `process.env.SUPERSURF_EXPERIMENTS = ...` setup with construction-time injection:
```typescript
const reg = new DaemonExperimentRegistry({ defaults: { page_diffing: true, ... } });
```

- [ ] **Step 4: Wire from main.ts**

In `daemon/src/main.ts`, where `DaemonExperimentRegistry` is constructed, pass `{ defaults: cfg.get().experiments }`.

- [ ] **Step 5: Build + run daemon tests**

Run: `npm run build.daemon && npm --prefix daemon test`
Expected: all pass

---

### Task 10: Daemon commit

- [ ] **Step 1: Stage and commit**

```bash
git add daemon/src daemon/tests daemon/dist
git commit -m "feat(daemon): wire ConfigService, auto-scaffold ~/.supersurf/config.json on startup"
```

---

### Phase 3: Wire into server

### Task 11: Server CLI flag → ConfigService

**Files:**
- Modify: `server/src/cli.ts`

- [ ] **Step 1: Replace resolveConfig defaults**

In `server/src/cli.ts`, locate `function resolveConfig(options)` (currently around line 40). Rewrite it so unset CLI flags pass `undefined` into ConfigService instead of falling back to hardcoded defaults inline.

```typescript
import {
  ConfigService,
  loadJsonConfig,
  loadEnvConfig,
  type PartialConfig,
} from 'shared';
import * as path from 'path';
import * as os from 'os';

function cliToPartial(options: any): PartialConfig {
  const out: PartialConfig = {};
  if (options.port !== undefined) out.daemon = { port: Number(options.port) };
  if (options.debug !== undefined) {
    out.logging = { debug: options.debug === 'no_truncate' ? true : !!options.debug };
  }
  if (options.disableSecureEval) out.security = { secure_eval: false };
  return out;
}

function buildConfig(options: any): ConfigService {
  const configPath = process.env.SUPERSURF_CONFIG_FILE
    || path.join(os.homedir(), '.supersurf', 'config.json');
  const { config: fileCfg, warnings: fileWarn } = loadJsonConfig(configPath);
  const { config: envCfg, warnings: envWarn } = loadEnvConfig(process.env);
  for (const w of [...fileWarn, ...envWarn]) console.error(`[server] ${w}`);
  return new ConfigService({
    cli: cliToPartial(options),
    env: envCfg,
    file: fileCfg,
    onWarn: (m) => console.error(`[server] ${m}`),
  });
}
```

Replace the existing call site that built `BackendConfig` so it now does:
```typescript
const configService = buildConfig(options);
const c = configService.get();
const backendConfig: BackendConfig = {
  port: c.daemon.port,
  debug: c.logging.debug,
  // ...whatever BackendConfig still needs
};
```

Keep `--log-file`, `--script-mode`, `--child` handling as-is — those are runtime flags, not config.

- [ ] **Step 2: Build + check that server still starts**

Run: `npm run build.shared && npm run build.server`
Expected: no type errors

- [ ] **Step 3: Smoke run**

Run: `node server/dist/cli.js --port 5556 --script-mode &` then send a quick stdio request, then kill.

Actually skip the smoke — leave verification for the integration test in Phase 5. Just confirm the build is clean.

---

### Task 12: server/src/experimental/index.ts reads from ConfigService

**Files:**
- Modify: `server/src/experimental/index.ts`

- [ ] **Step 1: Audit current `applyInitialState`**

`applyInitialState(config)` currently receives the legacy config blob. Change its signature to accept a `Config['experiments']` snapshot directly. Remove any `process.env.SUPERSURF_EXPERIMENTS` parsing if it exists in this file (the daemon now owns that).

- [ ] **Step 2: Update caller in backend handlers**

In `server/src/backend/handlers.ts`, the `onConnect` flow currently calls `applyInitialState(...)`. Update the call site to pass the experiments snapshot from ConfigService. ConfigService should be reachable from ConnectionManager (added in Task 11 via BackendConfig).

- [ ] **Step 3: Build + run existing tests**

Run: `npm run build.server && npm --prefix server test -- experimental`
Expected: pass

---

### Task 13: secure_eval reads from ConfigService

**Files:**
- Modify: `server/src/tools/browser_evaluate/index.ts`
- Modify: `server/tests/secure-eval.test.ts`

- [ ] **Step 1: Find the secure_eval gate**

Read `server/src/tools/browser_evaluate/index.ts` and locate where `SUPERSURF_DISABLE_SECURE_EVAL` is read or where `--disable-secure-eval` lands. There should be one branch that decides whether to run the AST analyzer + membrane.

- [ ] **Step 2: Replace env read with config read**

Pipe ConfigService access through ToolContext (or whatever struct the handler receives). Replace the env read with:
```typescript
const secureEvalEnabled = ctx.config.get().security.secure_eval;
```

- [ ] **Step 3: Update existing secure-eval test**

In `server/tests/secure-eval.test.ts`, find tests that set `SUPERSURF_DISABLE_SECURE_EVAL` and convert them to construct a ConfigService with `file: { security: { secure_eval: false } }` and inject through the test ToolContext.

- [ ] **Step 4: Build + run**

Run: `npm run build.server && npm --prefix server test -- secure-eval`
Expected: pass

---

### Task 14: Tips gated by config

**Files:**
- Modify: `server/src/tools/lib/dispatcher.ts`

- [ ] **Step 1: Make tip rendering conditional**

In `server/src/tools/lib/dispatcher.ts`, at the spot where `getTip` is called (around line 152), gate the call:
```typescript
const tipsEnabled = ctx.config?.get().tips ?? true;
const tip = (!options.rawResult && tipsEnabled)
  ? getTip(name, args, callResult, callError, sessionId)
  : null;
```

- [ ] **Step 2: Build + run dispatcher-related tests**

Run: `npm run build.server && npm --prefix server test -- tips tools`
Expected: existing tests pass (default is on, so no behavior change)

---

### Task 15: Commit Phase 3

- [ ] **Step 1: Stage and commit**

```bash
git add server/src server/tests server/dist
git commit -m "feat(server): consume ConfigService for experiments, secure_eval, tips, debug, port"
```

---

### Phase 4: Breaking changes

### Task 16: Delete experimental_features MCP tool

**Files:**
- Modify: `server/src/backend/schemas.ts`
- Modify: `server/src/backend/handlers.ts`
- Modify: `server/src/backend.ts`
- Modify: `server/tests/backend.test.ts`

- [ ] **Step 1: Write the failing test asserting tool is gone**

Add to `server/tests/backend.test.ts`:

```typescript
it('does not advertise experimental_features tool (removed in v2)', async () => {
  const mgr = new ConnectionManager({ port: 5555, debug: false });
  const tools = await mgr.listTools();
  const names = tools.map((t: any) => t.name);
  expect(names).not.toContain('experimental_features');
});

it('returns error for experimental_features call (removed in v2)', async () => {
  const mgr = new ConnectionManager({ port: 5555, debug: false });
  const res = await mgr.callTool('experimental_features', { page_diffing: true });
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toMatch(/removed.*v2/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server test -- backend.test`
Expected: FAIL — `experimental_features` is still in tools list

- [ ] **Step 3: Delete the schema**

In `server/src/backend/schemas.ts`, remove the entire `{ name: 'experimental_features', ... }` object from `getConnectionToolSchemas()` (lines ~70–93).

- [ ] **Step 4: Delete the handler**

In `server/src/backend/handlers.ts`:
1. Delete `onExperimentalFeatures` (around line 356 to end of function).
2. Remove the `onExperimentalFeatures` export from any barrel.
3. Update the import block at the top of `backend.ts` to drop `onExperimentalFeatures`.

In `server/src/backend.ts`:
1. Remove `'experimental_features'` from the `BACKEND_TOOLS` Set (line 135).
2. Remove the `case 'experimental_features':` arm in the switch.

- [ ] **Step 5: Replace dispatch with a deprecation stub**

The test asserts a clean error on call. The simplest path is: when `BACKEND_TOOLS` doesn't include `experimental_features`, the call will fall through to "bridge not connected" — which is wrong messaging. Instead, add an explicit early return at the top of `callTool`:

```typescript
if (name === 'experimental_features') {
  return options.rawResult
    ? { success: false, error: 'removed', message: 'experimental_features was removed in v2.0.0 — edit ~/.supersurf/config.json instead' }
    : {
        content: [{ type: 'text', text: '### Tool removed in v2.0.0\n\n`experimental_features` was retired. Edit `~/.supersurf/config.json` (auto-scaffolded on first daemon start) and restart the daemon.' }],
        isError: true,
      };
}
```

- [ ] **Step 6: Run test to verify pass**

Run: `npm --prefix server test -- backend.test`
Expected: PASS

- [ ] **Step 7: Update schemas tooltip in handlers.ts line 169**

Find the string at handlers.ts:169 referencing `experimental_features`. Replace with:
```
'Edit ~/.supersurf/config.json (auto-scaffolded on first daemon start) and restart the daemon to enable experiments.'
```

- [ ] **Step 8: Build full server, run all server tests**

Run: `npm run build.server && npm --prefix server test`
Expected: all pass

---

### Task 17: Rename AuditLogger → UsageMetricsLogger + file prefix

**Files:**
- Rename: `server/src/audit-logger.ts` → `server/src/usage-metrics-logger.ts`
- Modify: contents of renamed file
- Rename: `server/tests/audit-logger.test.ts` → `server/tests/usage-metrics-logger.test.ts`
- Modify: all importers

- [ ] **Step 1: Move the file**

```bash
git mv server/src/audit-logger.ts server/src/usage-metrics-logger.ts
git mv server/tests/audit-logger.test.ts server/tests/usage-metrics-logger.test.ts
```

- [ ] **Step 2: Rename the class and file prefix**

Open `server/src/usage-metrics-logger.ts`. Make these exact replacements:
- `class AuditLogger` → `class UsageMetricsLogger`
- `AuditEntry` interface name → keep as `MetricsEntry` (rename)
- `AUDIT_DIR` const → `METRICS_DIR` (path stays the same: `~/.supersurf/logs/sessions/`)
- The filename template: `audit-${safe}-${ts}.ndjson` → `metrics-${safe}-${ts}.ndjson`
- Any internal comments mentioning "audit" → "metrics"
- Export `redactParams` keeps its name (it's a utility, not domain-specific)

- [ ] **Step 3: Update importers**

Replace across the codebase:
- `from './audit-logger'` → `from './usage-metrics-logger'`
- `from '../audit-logger'` → `from '../usage-metrics-logger'`
- `AuditLogger` (class usage) → `UsageMetricsLogger`
- `AuditEntry` (type usage) → `MetricsEntry`

Targets:
- `server/src/backend.ts`
- `server/src/tools.ts`
- `server/src/tools/lib/dispatcher.ts`
- `server/src/backend/types.ts`
- `server/tests/usage-metrics-logger.test.ts` (renamed test file)
- `server/tests/tools-storage.test.ts`
- `server/tests/secure-eval.test.ts`
- `server/tests/tools.test.ts`
- `server/tests/backend.test.ts`

- [ ] **Step 4: Gate logger creation on `logging.usage_metrics`**

In `server/src/backend.ts`, find the `new AuditLogger(...)` site (line 142). Replace with:

```typescript
const c = this.configService.get();
if (name === 'connect' && !this.metricsLogger && rawArguments.client_id && c.logging.usage_metrics) {
  this.metricsLogger = new UsageMetricsLogger(String(rawArguments.client_id));
}
```

Then everywhere `this.auditLogger` appears in `backend.ts`, rename to `this.metricsLogger`. Same for tools dispatcher.

- [ ] **Step 5: Add a new test for the metrics-prefix file path**

In `server/tests/usage-metrics-logger.test.ts`, add:

```typescript
it('writes to metrics-* file path (not audit-*)', () => {
  const logger = new UsageMetricsLogger('test-session');
  expect(logger.filePath).toMatch(/metrics-test-session-/);
  expect(logger.filePath).not.toMatch(/audit-/);
});
```

(Expose `filePath` as a readonly public if not already.)

- [ ] **Step 6: Build + run all server tests**

Run: `npm run build.server && npm --prefix server test`
Expected: all pass

---

### Task 18: Update usage-data-audit skill to match new prefix

**Files:**
- Modify: `.claude/skills/usage-data-audit/SKILL.md`
- Modify: `.claude/skills/usage-data-audit/LEGEND.md` (if needed)

- [ ] **Step 1: Edit SKILL.md glob and references**

In `.claude/skills/usage-data-audit/SKILL.md`:
- Line 12: `audit logs live at ~/.supersurf/logs/sessions/audit-*.ndjson` → `usage-metrics logs live at ~/.supersurf/logs/sessions/metrics-*.ndjson (older sessions are at audit-*.ndjson — include both when sweeping)`
- Line 14: `server/src/audit-logger.ts` → `server/src/usage-metrics-logger.ts`
- Line 37: keep the v1.8.0 blind-spot note but add: "as of v2.0.0, logs are written to `metrics-*.ndjson`; older runs remain at `audit-*.ndjson`."
- Line 114: `server/src/audit-logger.ts` → `server/src/usage-metrics-logger.ts`
- Description on line 3: leave the user-facing skill name as `usage-data-audit` (don't rename the skill — too disruptive); update the description text to mention "usage metrics" alongside "audit logs" so it covers both naming eras.

- [ ] **Step 2: Sanity-read SKILL.md once**

Confirm any inline Python snippets glob both: `glob.glob(os.path.expanduser('~/.supersurf/logs/sessions/metrics-*.ndjson')) + glob.glob('~/.supersurf/logs/sessions/audit-*.ndjson')`. If none exist, add a paragraph explicitly directing the analyst to glob both prefixes.

- [ ] **Step 3: No commit yet — bundled with rename**

---

### Task 19: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update line 100**

Replace:
```
| `audit-logger.ts` | `AuditLogger` — structured NDJSON audit log for every tool call. Always-on. Redacts sensitive fields...
```
With:
```
| `usage-metrics-logger.ts` | `UsageMetricsLogger` — structured NDJSON usage-metrics log for every tool call. Gated by `config.logging.usage_metrics` (default true in scaffolded config, false in hardcoded defaults). Redacts sensitive fields (`value`, `password`, `token`, `secret`, `credential`), strips `data` fields (screenshot blobs). Writes to `~/.supersurf/logs/sessions/metrics-{sessionId}-{timestamp}.ndjson`. |
```

- [ ] **Step 2: Update line 103**

Replace `Audit-logs every tool call via AuditLogger` → `Logs every tool call via UsageMetricsLogger`.

- [ ] **Step 3: Update line 186**

Replace the "Audit logging:" paragraph with:
```
**Usage metrics logging:** Gated NDJSON usage-metrics trail at `~/.supersurf/logs/sessions/metrics-{sessionId}-{timestamp}.ndjson`. Enabled when `config.logging.usage_metrics` is true (default true in the auto-scaffolded `~/.supersurf/config.json`, false in raw hardcoded defaults). Every tool call is logged with timestamp, tool name, redacted params, result status, error message (if any), current URL, and wall time.
```

- [ ] **Step 4: Update line 234**

Replace `audit-logger.test.ts — AuditLogger` → `usage-metrics-logger.test.ts — UsageMetricsLogger`.

- [ ] **Step 5: Remove experimental_features from backend tool list**

Search CLAUDE.md for `experimental_features` and remove from any "backend tools" enumeration. Add a note: "`experimental_features` MCP tool retired in v2.0.0 — experiments are now toggled via `~/.supersurf/config.json`."

- [ ] **Step 6: Add Config section to CLAUDE.md**

After the existing Connection Lifecycle section, add:

```markdown
### Configuration

SuperSurf reads config from 3 layers, in priority order:

1. **CLI flag** — `--port`, `--debug`, `--disable-secure-eval` (server only)
2. **Environment variable** — `SUPERSURF_PORT`, `SUPERSURF_DEBUG`, `SUPERSURF_DISABLE_SECURE_EVAL`, `SUPERSURF_EXPERIMENTS`, `SUPERSURF_CONFIG_FILE`
3. **JSON file** — `~/.supersurf/config.json`, auto-scaffolded on first daemon start

Unset values fall through to hardcoded defaults in `shared/config/defaults.ts`. The ConfigService (`shared/config/service.ts`) owns merge and per-leaf source tracking. Both daemon and server consume the same ConfigService — file path can be overridden via `SUPERSURF_CONFIG_FILE`.

Config changes require a daemon restart. There is no hot-reload.
```

---

### Task 20: Commit breaking changes

- [ ] **Step 1: Stage and commit**

```bash
git add server/src server/tests server/dist .claude/skills/usage-data-audit CLAUDE.md
git commit -m "feat!(server): retire experimental_features MCP tool, rename AuditLogger → UsageMetricsLogger

BREAKING: experimental_features MCP tool removed — use ~/.supersurf/config.json
BREAKING: audit-*.ndjson renamed to metrics-*.ndjson
BREAKING: AuditLogger class renamed to UsageMetricsLogger"
```

---

### Phase 5: Release

### Task 21: CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Replace the `## Unreleased` block**

Replace the existing `## Unreleased` section with:

```markdown
## 2.0.0 — 2026-05-11

- **BREAKING: feat**: 3-layer ConfigService — CLI flag > env var > `~/.supersurf/config.json` > hardcoded defaults. Daemon auto-scaffolds `~/.supersurf/config.json` on first run with safe defaults. ConfigService lives in the `shared/` workspace so daemon and server consume one source of truth
- **BREAKING: feat**: `experimental_features` MCP tool removed. Experiments are now opted into via `~/.supersurf/config.json` and require a daemon restart. Rationale: audit-log data showed 4 of 5 historical callers used it once at startup; the remaining call sites became impossible after `secure_eval` graduated in v1.11.0
- **BREAKING: feat**: `AuditLogger` → `UsageMetricsLogger` rename. New session files are written as `metrics-{sessionId}-{ts}.ndjson` (was `audit-{sessionId}-{ts}.ndjson`). Older sessions remain at the old path; the usage-data-audit skill globs both prefixes
- **BREAKING: feat**: usage-metrics logging is now gated by `config.logging.usage_metrics`. Hardcoded default is `false`, scaffolded `~/.supersurf/config.json` default is `true` — operators who never touch config still get telemetry; operators with a config file opt in explicitly by leaving the default
- feat: new env vars `SUPERSURF_CONFIG_FILE` (path override) and `SUPERSURF_DEBUG` (alias for `--debug`)
- chore: CLAUDE.md updated for v2 architecture
- chore: usage-data-audit skill updated to glob both `metrics-*.ndjson` and legacy `audit-*.ndjson`
```

- [ ] **Step 2: Stage**

Don't commit yet — bundle with the version bump.

---

### Task 22: Version bump

- [ ] **Step 1: Run version bump**

Run: `npm run version.bump major`
Expected: bumps shared, daemon, server, extension all to 2.0.0; commits.

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: success across all packages.

- [ ] **Step 3: Verify full test suite**

Run: `npm run test`
Expected: all daemon + server + extension tests pass.

- [ ] **Step 4: Final smoke check**

Manually:
1. Move any existing `~/.supersurf/config.json` aside: `mv ~/.supersurf/config.json ~/.supersurf/config.json.bak`
2. Start daemon: `npm --prefix daemon start`
3. Confirm `~/.supersurf/config.json` was created and `cat` shows `usage_metrics: true`.
4. Restore: `mv ~/.supersurf/config.json.bak ~/.supersurf/config.json`

- [ ] **Step 5: User pushes**

Tell the user the release is ready and they should `git push` plus run `npm run publish`. Do not run those commands yourself.

---

## Self-Review

**Spec coverage check:**
- 3-layer config (CLI > env > file > defaults) → Tasks 1–7 build it, 8/11 wire it
- Auto-scaffold → Task 6 implements, Task 8 invokes from daemon
- Malformed JSON → defaults + warn → Task 3
- Unknown keys / wrong types → warn + default → Task 5
- usage_metrics: false in defaults, true in scaffold → Task 2
- 5 env flags → Task 4
- 3 CLI flags wired → Task 11
- Retire experimental_features tool → Task 16
- Rename AuditLogger → UsageMetricsLogger → Task 17
- Skill update in same commit as rename → Tasks 17–20 share a commit
- CLAUDE.md sweep → Task 19
- v2.0.0 bump → Task 22

**Placeholder scan:** No "TBD", "implement later", or skeleton steps — every step has either exact code or exact shell commands.

**Type consistency:** `AuditEntry` renamed to `MetricsEntry` in Task 17 and consistently referenced thereafter. `Config` shape defined in Task 1 and used identically by service.ts (Task 5), defaults.ts (Task 2), loaders.ts (Tasks 3–4). `MetricsEntry` (renamed from `AuditEntry`) keeps the existing field set — no fields are added or removed in this plan.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-11-v2-config-consolidation.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

---

TLDR: Plan written. 22 tasks across 5 phases. Phase 1 builds ConfigService in `shared/` with full TDD coverage. Phases 2–3 wire daemon + server to consume it. Phase 4 ships the breaking changes (delete `experimental_features` tool, rename AuditLogger → UsageMetricsLogger with file prefix change). Phase 5 cuts v2.0.0. Skill + CLAUDE.md updates bundled into the rename commit so docs and code stay in lockstep. Pick subagent-driven or inline execution.
