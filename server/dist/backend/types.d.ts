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
import type { UsageMetricsLogger } from '../usage-metrics-logger';
import type { ConfigService } from 'shared';
/** Server configuration resolved from CLI options and environment variables. */
export interface BackendConfig {
    debug: boolean;
    port: number;
    server: {
        name: string;
        version: string;
    };
    enabledExperiments?: string[];
    /** Resolved ConfigService (CLI + env + file + defaults). Threaded into ToolContext. */
    configService?: ConfigService;
    /** True when this process detected a major-version upgrade at startup (checked once,
     *  not re-read per tool call). Surfaced as a one-shot notice in the `connect` response. */
    showUpgradeNotice?: boolean;
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
    metricsLogger: UsageMetricsLogger | null;
    /** Reason the last `connect` attempt failed, surfaced in the passive status
     *  header so `status` reports the real cause (e.g. port held / EADDRINUSE)
     *  instead of a bare cached "Disabled". Cleared on the next connect attempt. */
    lastConnectError: string | null;
    statusHeader(): string;
    notifyToolsListChanged(): Promise<void>;
    sendLogNotification(level: string, message: string, logger?: string): Promise<void>;
}
//# sourceMappingURL=types.d.ts.map