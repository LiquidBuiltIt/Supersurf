/**
 * BrowserBridge — orchestrator for browser tool dispatch.
 *
 * Thin lifecycle wrapper. Builds a ToolContext from the transport,
 * connection manager, and helper modules, then delegates dispatch to
 * `tools/dispatcher.ts`. The CDP/eval primitives, element resolver, and
 * result formatter live in sibling modules.
 *
 * @module tools
 */

import type { IExtensionTransport } from './bridge';
import type { ToolSchema, ToolContext } from './tools/types';
import { createLog } from './logger';
import { AuditLogger } from './audit-logger';
import { getExperimentalToolSchemas, experimentRegistry } from './experimental/index';

import { getToolSchemas } from './tools/schemas';
import { cdp as cdpFn, evalExpr as evalFn } from './tools/cdp';
import {
  getElementCenter,
  getSelectorExpression,
  findAlternativeSelectors,
} from './tools/element-resolver';
import { formatResult, formatError } from './tools/result-formatter';
import { dispatchTool } from './tools/dispatcher';

const log = createLog('[Bridge]');

/**
 * Lifecycle wrapper for browser tool execution. Created by
 * `backend/handlers.ts:onConnect` after the daemon transport is up;
 * `initialize()` wires in the MCP server, client metadata, connection
 * manager, and audit logger.
 */
export class BrowserBridge {
  private config: any;
  private ext: IExtensionTransport | null;
  private server: any = null;
  private clientInfo: any = {};
  private connectionManager: any = null;
  private auditLogger: AuditLogger | null = null;

  constructor(config: any, ext: IExtensionTransport | null) {
    this.config = config;
    this.ext = ext;
  }

  async initialize(
    server: any,
    clientInfo: any,
    connectionManager?: any,
    auditLogger?: AuditLogger,
  ): Promise<void> {
    this.server = server;
    this.clientInfo = clientInfo;
    this.connectionManager = connectionManager;
    this.auditLogger = auditLogger ?? new AuditLogger(connectionManager?.clientId ?? 'unknown');
  }

  serverClosed(): void {
    log('Server closed');
  }

  /** Return all registered tool schemas (core + experimental). */
  async listTools(): Promise<ToolSchema[]> {
    return [...getToolSchemas(), ...getExperimentalToolSchemas()];
  }

  /** Build the ToolContext that handlers receive. */
  private buildContext(): ToolContext {
    const ext = this.ext!;
    const evalFnBound = (expression: string, awaitPromise = true) =>
      evalFn(ext, expression, awaitPromise);
    return {
      ext,
      connectionManager: this.connectionManager,
      cdp: (method, params) => cdpFn(ext, method, params),
      eval: evalFnBound,
      sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
      getElementCenter: (selector: string) => getElementCenter(evalFnBound, selector),
      getSelectorExpression,
      findAlternativeSelectors: (selector: string) => findAlternativeSelectors(evalFnBound, selector),
      formatResult: (name, result, options) =>
        formatResult(name, result, options, this.connectionManager),
      error: (message, options) => formatError(message, options),
    };
  }

  /**
   * Dispatch a named tool call. Short-circuits with a help-text error
   * when the extension transport is missing, otherwise forwards to
   * `dispatchTool`.
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options: { rawResult?: boolean } = {},
  ): Promise<any> {
    if (!this.ext) {
      const response = formatError(
        'Extension not connected.\n\n' +
        '**The extension typically auto-connects within a few seconds after calling `connect`. Wait a moment and retry this tool call.**\n\n' +
        '**If the issue persists:**\n' +
        '1. Run `npx supersurf-daemon status` to check if the daemon is running\n' +
        '2. Ensure the SuperSurf extension is loaded in Chrome (`chrome://extensions`)\n' +
        '3. Open the extension popup and verify it shows "Connected"',
        options,
      );
      this.auditLogger?.write({
        session_id: this.connectionManager?.clientId ?? 'unknown',
        tool: name,
        params: args,
        result: 'error',
        error: 'Extension not connected',
        experiments: experimentRegistry.getStates(),
        duration_ms: 0,
      });
      return response;
    }

    return await dispatchTool(this.buildContext(), name, args, options, {
      auditLogger: this.auditLogger,
      clientId: this.connectionManager?.clientId,
      getCurrentUrl: () => this.connectionManager?.getAttachedTab()?.url,
    });
  }
}
