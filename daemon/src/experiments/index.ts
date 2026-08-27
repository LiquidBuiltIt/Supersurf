/**
 * DaemonExperimentRegistry — per-session experiment state owned by the daemon.
 *
 * The daemon is the source of truth for which experiments are enabled per session.
 * MCP servers query/toggle experiment state via IPC messages (experiments.toggle,
 * experiments.get, experiments.getOne) and cache results locally.
 *
 * @module experiments/index
 */

import type { FileLogger, Config } from 'shared';

/** All recognized session-toggleable experiment names. */
const AVAILABLE_EXPERIMENTS = [
  'page_diffing',
  'smart_waiting',
  'mouse_humanization',
  'fingerprinting',
] as const;

const debugLog = (...args: unknown[]) => {
  const logger = (global as any).DAEMON_LOGGER as FileLogger | undefined;
  if (logger) logger.log('[Experiments]', ...args);
};

export interface DaemonExperimentRegistryOptions {
  /** Resolved experiments snapshot from ConfigService. */
  defaults?: Config['experiments'];
}

/**
 * Per-session experiment state registry.
 *
 * Stores which experiments each MCP session has enabled. Sessions that haven't
 * explicitly toggled anything inherit from defaults injected at construction
 * time (from ConfigService, which merges file + env + CLI inputs).
 */
export class DaemonExperimentRegistry {
  /** sessionId → Set of enabled experiment names */
  private _sessions: Map<string, Set<string>> = new Map();
  /** Experiments pre-enabled by injected config snapshot. */
  private _defaults: Set<string> = new Set();

  constructor(opts: DaemonExperimentRegistryOptions = {}) {
    if (opts.defaults) {
      for (const [name, enabled] of Object.entries(opts.defaults)) {
        if (enabled && this.isAvailable(name)) {
          this._defaults.add(name);
          debugLog(`Default enabled: ${name}`);
        }
      }
    }
  }

  /**
   * Apply experiment defaults. Retained for backwards compatibility with
   * call sites that supply a string list (e.g., tests). New code should
   * inject defaults via the constructor.
   */
  applyDefaults(experiments: string[]): void {
    for (const exp of experiments) {
      if (this.isAvailable(exp)) {
        this._defaults.add(exp);
        debugLog(`Default enabled: ${exp}`);
      }
    }
  }

  /**
   * Toggle an experiment for a session.
   * Lazy-initializes the session's Set from defaults on first access.
   */
  toggle(sessionId: string, experiment: string, enabled: boolean): boolean {
    if (!this.isAvailable(experiment)) {
      throw new Error(
        `Unknown experiment: "${experiment}". Available: ${AVAILABLE_EXPERIMENTS.join(', ')}`
      );
    }

    let sessionSet = this._sessions.get(sessionId);
    if (!sessionSet) {
      sessionSet = new Set(this._defaults);
      this._sessions.set(sessionId, sessionSet);
    }

    if (enabled) {
      sessionSet.add(experiment);
    } else {
      sessionSet.delete(experiment);
    }

    debugLog(`${sessionId}: ${experiment} = ${enabled}`);
    return enabled;
  }

  /** Check if an experiment is enabled for a session. */
  isEnabled(sessionId: string, experiment: string): boolean {
    const sessionSet = this._sessions.get(sessionId);
    if (sessionSet) return sessionSet.has(experiment);
    return this._defaults.has(experiment);
  }

  /** Get all experiment states for a session. */
  getAll(sessionId: string): Record<string, boolean> {
    const states: Record<string, boolean> = {};
    for (const exp of AVAILABLE_EXPERIMENTS) {
      states[exp] = this.isEnabled(sessionId, exp);
    }
    return states;
  }

  /** Clean up a session's experiment state. */
  deleteSession(sessionId: string): void {
    this._sessions.delete(sessionId);
    debugLog(`Session deleted: ${sessionId}`);
  }

  /** Initialize a session with defaults. No-op if already initialized. */
  initSession(sessionId: string): void {
    if (!this._sessions.has(sessionId)) {
      this._sessions.set(sessionId, new Set(this._defaults));
    }
  }

  /** Check if an experiment name is recognized. */
  isAvailable(experiment: string): boolean {
    return (AVAILABLE_EXPERIMENTS as readonly string[]).includes(experiment);
  }

  /** Return all recognized experiment names. */
  listAvailable(): readonly string[] {
    return AVAILABLE_EXPERIMENTS;
  }
}
