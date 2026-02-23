/**
 * ExperimentRegistry — session-scoped feature flag registry for experimental features.
 *
 * Manages the lifecycle of toggleable experiments (page_diffing, smart_waiting,
 * storage_inspection, mouse_humanization, secure_eval). Experiments are toggled
 * per-session via the `experimental_features` MCP tool.
 *
 * Also serves as the dispatch layer for experimental tools — collects schemas
 * and routes tool calls to their respective handlers.
 *
 * @module experimental/index
 *
 * Key exports:
 * - {@link experimentRegistry} — singleton registry instance
 * - {@link isInfraExperimentEnabled} — check env-var-gated infrastructure experiments
 * - {@link applyInitialState} — pre-enable experiments from startup config
 * - {@link getExperimentalToolSchemas} — collect MCP tool schemas from experimental modules
 * - {@link callExperimentalTool} — route experimental tool calls to handlers
 */

export { diffSnapshots, calculateConfidence, formatDiffSection } from './page-diffing';
export type { PageState, DiffResult } from './page-diffing';
export { analyzeCode, wrapWithPageProxy } from './secure-eval';
export type { AnalysisResult } from './secure-eval';

import type { ToolSchema, ToolContext } from '../tools/types';
import { storageInspectionSchema, onBrowserStorage } from './storage-inspection';

/** All recognized session-toggleable experiment names. */
const AVAILABLE_EXPERIMENTS = ['page_diffing', 'smart_waiting', 'storage_inspection', 'mouse_humanization', 'secure_eval'] as const;
type ExperimentName = typeof AVAILABLE_EXPERIMENTS[number];

/**
 * Session-scoped feature flag registry.
 *
 * Tracks which experiments are currently enabled. Validation ensures only
 * recognized experiment names can be toggled — unknown names throw immediately
 * to surface typos at the call site.
 */
class ExperimentRegistry {
  private _enabled: Map<string, boolean> = new Map();

  /** Enable an experiment. Throws if the name is not in AVAILABLE_EXPERIMENTS. */
  enable(feature: string): void {
    if (!this.isAvailable(feature)) {
      throw new Error(`Unknown experiment: "${feature}". Available: ${AVAILABLE_EXPERIMENTS.join(', ')}`);
    }
    this._enabled.set(feature, true);
  }

  /** Disable an experiment. Throws if the name is not in AVAILABLE_EXPERIMENTS. */
  disable(feature: string): void {
    if (!this.isAvailable(feature)) {
      throw new Error(`Unknown experiment: "${feature}". Available: ${AVAILABLE_EXPERIMENTS.join(', ')}`);
    }
    this._enabled.set(feature, false);
  }

  /** Returns true only if the experiment has been explicitly enabled. */
  isEnabled(feature: string): boolean {
    return this._enabled.get(feature) === true;
  }

  /** Clear all experiment states (used in tests and session teardown). */
  reset(): void {
    this._enabled.clear();
  }

  /** Return a copy of all recognized experiment names. */
  listAvailable(): string[] {
    return [...AVAILABLE_EXPERIMENTS];
  }

  /** Return a snapshot of all experiments and their current enabled/disabled state. */
  getStates(): Record<string, boolean> {
    const states: Record<string, boolean> = {};
    for (const exp of AVAILABLE_EXPERIMENTS) {
      states[exp] = this.isEnabled(exp);
    }
    return states;
  }

  /** Check if a feature name is recognized (exists in AVAILABLE_EXPERIMENTS). */
  isAvailable(feature: string): boolean {
    return (AVAILABLE_EXPERIMENTS as readonly string[]).includes(feature);
  }
}

export const experimentRegistry = new ExperimentRegistry();

/**
 * Check if an infrastructure-level experiment (e.g. "multiplexer") is enabled via env var.
 * Infrastructure experiments are gated at startup, not session-toggleable.
 */
export function isInfraExperimentEnabled(
  feature: string,
  config: { enabledExperiments?: string[] }
): boolean {
  if (!config.enabledExperiments) return false;
  return config.enabledExperiments.includes(feature);
}

/**
 * Pre-enable session features listed in the env var config.
 * Silently skips infra features (like "multiplexer") that aren't in AVAILABLE_EXPERIMENTS.
 */
export function applyInitialState(config: { enabledExperiments?: string[] }): void {
  if (!config.enabledExperiments) return;
  for (const feature of config.enabledExperiments) {
    if (experimentRegistry.isAvailable(feature)) {
      experimentRegistry.enable(feature);
    }
  }
}

// ─── Experimental tool dispatch ───────────────────────────────

/** Collect schemas from all experimental tool modules */
export function getExperimentalToolSchemas(): ToolSchema[] {
  return [storageInspectionSchema];
}

/**
 * Try to dispatch a tool call to an experimental handler.
 * Returns the result if handled, or null if the tool name isn't experimental.
 */
export async function callExperimentalTool(
  name: string,
  ctx: ToolContext,
  args: Record<string, unknown>,
  options: { rawResult?: boolean }
): Promise<any | null> {
  switch (name) {
    case 'browser_storage':
      return await onBrowserStorage(ctx, args, options);
    default:
      return null;
  }
}
