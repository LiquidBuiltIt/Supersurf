/**
 * ExperimentRegistry — cache-backed IPC proxy for experiment state.
 *
 * The daemon owns experiment state. This registry caches enabled/disabled
 * flags locally for synchronous reads (isEnabled) and IPCs toggle operations
 * to the daemon. Processing logic (page diffing, AST analysis, waypoint
 * generation) remains server-side.
 *
 * @module experimental/index
 *
 * Key exports:
 * - {@link experimentRegistry} — singleton registry instance
 * - {@link applyInitialState} — pre-enable experiments from startup config
 * - {@link getExperimentalToolSchemas} — collect MCP tool schemas from experimental modules
 * - {@link callExperimentalTool} — route experimental tool calls to handlers
 */

export { diffSnapshots, calculateConfidence, formatDiffSection } from './page-diffing';
export type { PageState, DiffResult } from './page-diffing';

import type { ToolSchema, ToolContext } from '../tools/lib/types';
import type { IExtensionTransport } from '../bridge';
import type { Config } from 'shared';
import { storageInspectionSchema, onBrowserStorage } from './storage-inspection';

/** All recognized session-toggleable experiment names. */
const AVAILABLE_EXPERIMENTS = ['page_diffing', 'smart_waiting', 'storage_inspection', 'mouse_humanization', 'fingerprinting'] as const;
type ExperimentName = typeof AVAILABLE_EXPERIMENTS[number];

/**
 * Cache-backed IPC proxy for experiment state.
 *
 * Reads are synchronous (from local cache). Writes IPC to the daemon and
 * update the cache on success. The ~20 isEnabled() call sites in tools/
 * remain unchanged — same sync signature, same behavior.
 */
class ExperimentRegistry {
  private _cache: Map<string, boolean> = new Map();
  private _transport: IExtensionTransport | null = null;

  /** Bind to a daemon transport. Called on connect. */
  bind(transport: IExtensionTransport): void {
    this._transport = transport;
  }

  /** Unbind transport and clear cache. Called on disconnect. */
  unbind(): void {
    this._transport = null;
    this._cache.clear();
  }

  /**
   * Toggle an experiment. IPCs to daemon, then updates local cache.
   * Reserved for programmatic use; v2 disables session-level toggling
   * via MCP (experiments come from `~/.supersurf/config.json`).
   */
  async toggle(feature: string, enabled: boolean): Promise<void> {
    if (!this.isAvailable(feature)) {
      throw new Error(`Unknown experiment: "${feature}". Available: ${AVAILABLE_EXPERIMENTS.join(', ')}`);
    }

    if (this._transport && this._transport.connected) {
      await this._transport.sendCmd('experiments.toggle', { experiment: feature, enabled }, 5000);
    }
    this._cache.set(feature, enabled);
  }

  /**
   * Enable an experiment. Fire-and-forget IPC for backwards compat with applyInitialState.
   * Throws if the name is not in AVAILABLE_EXPERIMENTS.
   */
  enable(feature: string): void {
    if (!this.isAvailable(feature)) {
      throw new Error(`Unknown experiment: "${feature}". Available: ${AVAILABLE_EXPERIMENTS.join(', ')}`);
    }
    if (this._transport && this._transport.connected) {
      this._transport.sendCmd('experiments.toggle', { experiment: feature, enabled: true }, 5000).catch(() => {});
    }
    this._cache.set(feature, true);
  }

  /**
   * Disable an experiment. Fire-and-forget IPC for backwards compat.
   * Throws if the name is not in AVAILABLE_EXPERIMENTS.
   */
  disable(feature: string): void {
    if (!this.isAvailable(feature)) {
      throw new Error(`Unknown experiment: "${feature}". Available: ${AVAILABLE_EXPERIMENTS.join(', ')}`);
    }
    if (this._transport && this._transport.connected) {
      this._transport.sendCmd('experiments.toggle', { experiment: feature, enabled: false }, 5000).catch(() => {});
    }
    this._cache.set(feature, false);
  }

  /** Returns true only if the experiment is enabled in the local cache. Sync — no IPC. */
  isEnabled(feature: string): boolean {
    return this._cache.get(feature) === true;
  }

  /** Clear local cache. Daemon handles session cleanup on disconnect. */
  reset(): void {
    this._cache.clear();
  }

  /** Return a copy of all recognized experiment names. */
  listAvailable(): string[] {
    return [...AVAILABLE_EXPERIMENTS];
  }

  /** Return a snapshot of all experiments and their current cached state. */
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
 * Pre-enable session features from a Config experiments snapshot.
 * Silently skips feature names that aren't in AVAILABLE_EXPERIMENTS
 * (notably `profiles`, which is a daemon-startup flag, not session-toggleable).
 * Fire-and-forget IPCs to daemon for each enabled experiment.
 */
export function applyInitialState(experiments: Config['experiments']): void {
  for (const [name, enabled] of Object.entries(experiments)) {
    if (enabled && experimentRegistry.isAvailable(name)) {
      experimentRegistry.enable(name);
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
