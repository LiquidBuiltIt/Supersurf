import * as fs from 'fs';
import type { Config, PartialConfig } from './types';

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

const KNOWN_EXPERIMENTS = [
  'page_diffing', 'smart_waiting', 'storage_inspection', 'mouse_humanization', 'fingerprinting',
] as const;

type ExperimentName = (typeof KNOWN_EXPERIMENTS)[number];

function isKnownExperiment(s: string): s is ExperimentName {
  return (KNOWN_EXPERIMENTS as readonly string[]).includes(s);
}

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
    if (env.SUPERSURF_DEBUG === 'no_truncate') {
      out.logging = { ...(out.logging || {}), debug: 'no_truncate' };
    } else if (isTruthy(env.SUPERSURF_DEBUG)) {
      out.logging = { ...(out.logging || {}), debug: 'truncate' };
    }
    // Falsy values (0, false, off, no) leave the partial untouched so file/defaults take effect.
  }

  if (env.SUPERSURF_EXPERIMENTS) {
    const names = env.SUPERSURF_EXPERIMENTS.split(',').map((s) => s.trim()).filter(Boolean);
    const expOut: Partial<Config['experiments']> = {};
    for (const name of names) {
      if (isKnownExperiment(name)) {
        expOut[name] = true;
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
