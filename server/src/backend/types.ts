/**
 * Shared types for the backend module.
 *
 * Defines the configuration, state, and interface contracts used across
 * the ConnectionManager, handlers, and status builder. Kept in a separate
 * file to avoid circular imports between backend.ts and handlers.ts.
 *
 * @module backend/types
 */

import type { IExtensionTransport } from '../bridge';

/** Server configuration resolved from CLI options and environment variables. */
export interface BackendConfig {
  debug: boolean;
  port: number;
  server: { name: string; version: string };
  enabledExperiments?: string[];
}

/** Metadata for the currently attached browser tab. */
export interface TabInfo {
  id?: number;
  index?: number;
  title?: string;
  url?: string;
  techStack?: any;
}

/** Connection lifecycle state: passive (idle), active (WS listening), connected (extension linked). */
export type BackendState = 'passive' | 'active' | 'connected';

/** MCP tool definition with name, description, JSON Schema input, and optional annotations. */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/**
 * Public interface of ConnectionManager exposed to handler functions.
 * Handlers need both read and write access to manage state transitions.
 */
export interface ConnectionManagerAPI {
  config: BackendConfig;
  debugMode: boolean;
  state: BackendState;
  bridge: any;
  extensionServer: IExtensionTransport | null;
  server: any;
  clientInfo: Record<string, unknown>;
  clientId: string | null;
  connectedBrowserName: string | null;
  attachedTab: TabInfo | null;
  statusHeader(): string;
  notifyToolsListChanged(): Promise<void>;
  sendLogNotification(level: string, message: string, logger?: string): Promise<void>;
}
