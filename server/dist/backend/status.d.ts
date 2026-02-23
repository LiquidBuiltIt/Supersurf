/**
 * Status header builder — pure function, no side effects.
 *
 * Generates a compact one-line status string prepended to every MCP tool response.
 * Includes version, browser name, attached tab URL (truncated), tech stack summary,
 * and stealth indicator. In debug mode, also shows the extension build timestamp.
 *
 * @module backend/status
 * @exports buildStatusHeader
 */
import type { BackendConfig, BackendState, TabInfo } from './types';
import type { IExtensionTransport } from '../bridge';
/** All the state needed to build the status header, passed in to keep the function pure. */
interface StatusInput {
    config: BackendConfig;
    state: BackendState;
    debugMode: boolean;
    connectedBrowserName: string | null;
    attachedTab: TabInfo | null;
    stealthMode: boolean;
    extensionServer: IExtensionTransport | null;
}
/**
 * Build a pipe-delimited status header from current connection state.
 * Returns a string ending with `\n---\n\n` for markdown separation.
 */
export declare function buildStatusHeader(input: StatusInput): string;
export {};
//# sourceMappingURL=status.d.ts.map