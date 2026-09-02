/**
 * Transport-layer contract between an MCP session and whatever owns the
 * extension WebSocket. Lives in `shared/` because both `server/` (ExtensionServer,
 * ConnectionManager) and the compiled `cli/` binary (DaemonClient) implement or
 * consume it, and neither may import the other.
 *
 * @module daemon-ipc/types
 */
export interface DialogEvent {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultPrompt: string;
  url: string;
  hasBrowserHandler: boolean;
  timestamp: number;
}

export interface IExtensionTransport {
  sendCmd(method: string, params?: Record<string, unknown>, timeout?: number): Promise<any>;
  readonly connected: boolean;
  readonly browser: string;
  readonly buildTime: string | null;
  onReconnect: (() => void) | null;
  onTabInfoUpdate: ((tabInfo: any) => void) | null;
  notifyClientId(clientId: string): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Drain buffered native-dialog events accumulated from prior responses. */
  consumeDialogEvents(): DialogEvent[];
}
