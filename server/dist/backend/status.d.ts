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
    /** Slot-scoped extension presence; when false in a non-passive state the
     *  header renders ⚠️ + a hint instead of ✅. Undefined = legacy caller, treat as connected. */
    extensionConnected?: boolean;
    /** When true, prepends a one-time warning that `~/.supersurf/config.json` changed since daemon start. */
    configDriftWarning?: boolean;
    /** Reason the last connect attempt failed; shown in the passive header so a wedged
     *  daemon / port conflict is reported instead of a bare "Disabled". */
    lastConnectError?: string | null;
    /** Pre-rendered `playbooks/hint.ts:formatPlaybookHintLine` output, or null/undefined
     *  when there is nothing to show. Domain matching and once-per-session suppression
     *  happen in `ConnectionManager` — this function only places the line. */
    playbookHint?: string | null;
    /** Pre-rendered `playbooks/hint.ts:formatInvalidPlaybookWarning` output, or
     *  null when every script validates. Placed ABOVE the hint so a broken file
     *  is never hidden behind a suggestion. */
    playbookWarning?: string | null;
}
/**
 * Build a pipe-delimited status header from current connection state.
 * Returns a string ending with `\n---\n\n` for markdown separation.
 */
export declare function buildStatusHeader(input: StatusInput): string;
export {};
//# sourceMappingURL=status.d.ts.map