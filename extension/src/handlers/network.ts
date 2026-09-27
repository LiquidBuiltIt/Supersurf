/**
 * @module handlers/network
 *
 * Tracks HTTP request/response lifecycle via Chrome's webRequest API.
 * Captures request method, headers, body, response status, and errors
 * into a capped ring buffer ({@link MAX_REQUESTS} entries).
 *
 * Key exports:
 * - {@link NetworkTracker} — stateful tracker instantiated by background.ts
 *
 * Adapted from Blueprint MCP (Apache 2.0)
 */

import { Logger } from '../utils/logger.js';

/** Accumulated metadata for a single HTTP request through its lifecycle. */
interface NetworkRequest {
  requestId: string;
  /**
   * Owning tab, or -1 for requests with no tab. This is what makes the log
   * attributable: without it every session reads every other session's
   * traffic, because one Chrome profile has one webRequest stream.
   */
  tabId: number;
  url: string;
  method: string;
  /** Resource type (e.g. "xmlhttprequest", "script", "image"). */
  type: string;
  timestamp: number;
  statusCode?: number;
  statusLine?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: any;
  /** Set when webRequest.onErrorOccurred fires (e.g. net::ERR_CONNECTION_REFUSED). */
  error?: string;
}

/** Maximum tracked requests before oldest entries are evicted (FIFO). */
const MAX_REQUESTS = 500;

/**
 * Captures network traffic across the four webRequest lifecycle events:
 * onBeforeRequest -> onBeforeSendHeaders -> onCompleted / onErrorOccurred.
 *
 * Requests are keyed by Chrome's `requestId` and progressively enriched
 * as each event fires. The server queries via {@link getRequests}.
 */
export class NetworkTracker {
  private browser: typeof chrome;
  private logger: Logger;
  /** Ring buffer keyed by requestId. Insertion order = chronological order. */
  private requests: Map<string, NetworkRequest> = new Map();

  constructor(browserAPI: typeof chrome, logger: Logger) {
    this.browser = browserAPI;
    this.logger = logger;
  }

  /** Register webRequest listeners for all URLs. Must be called once after construction. */
  init(): void {
    const filter = { urls: ['<all_urls>'] };

    this.browser.webRequest.onBeforeRequest.addListener(
      (details) => this._handleBeforeRequest(details),
      filter,
      ['requestBody']
    );

    this.browser.webRequest.onBeforeSendHeaders.addListener(
      (details) => this._handleBeforeSendHeaders(details),
      filter,
      ['requestHeaders']
    );

    this.browser.webRequest.onCompleted.addListener(
      (details) => this._handleCompleted(details),
      filter,
      ['responseHeaders']
    );

    this.browser.webRequest.onErrorOccurred.addListener(
      (details) => this._handleError(details),
      filter
    );
  }

  /**
   * Return tracked requests oldest-first, filtered to one tab when given.
   * Callers that can name a tab MUST pass it — an unfiltered read hands the
   * caller every other session's traffic.
   */
  getRequests(tabId?: number): NetworkRequest[] {
    const all = Array.from(this.requests.values());
    return tabId === undefined ? all : all.filter((r) => r.tabId === tabId);
  }

  /**
   * Drop tracked requests — only the named tab's when given, all when not.
   * The unscoped clear is destructive across sessions: it deletes traffic the
   * clearing session never captured and cannot get back.
   */
  clearRequests(tabId?: number): void {
    if (tabId === undefined) {
      this.requests.clear();
      return;
    }
    for (const [id, req] of this.requests) {
      if (req.tabId === tabId) this.requests.delete(id);
    }
  }

  /** Create initial entry on request start, evicting oldest if at capacity. */
  private _handleBeforeRequest(details: chrome.webRequest.WebRequestBodyDetails): void {
    // Trim to max
    if (this.requests.size >= MAX_REQUESTS) {
      const oldest = this.requests.keys().next().value;
      if (oldest) this.requests.delete(oldest);
    }

    this.requests.set(details.requestId, {
      requestId: details.requestId,
      tabId: details.tabId,
      url: details.url,
      method: details.method,
      type: details.type,
      timestamp: details.timeStamp,
      requestBody: details.requestBody || undefined,
    });
  }

  /** Attach request headers (flattened from Chrome's array format to a plain object). */
  private _handleBeforeSendHeaders(details: chrome.webRequest.WebRequestHeadersDetails): void {
    const req = this.requests.get(details.requestId);
    if (req && details.requestHeaders) {
      req.requestHeaders = {};
      for (const header of details.requestHeaders) {
        if (header.name && header.value) {
          req.requestHeaders[header.name] = header.value;
        }
      }
    }
  }

  /** Record response status and headers on successful completion. */
  private _handleCompleted(details: chrome.webRequest.WebResponseCacheDetails): void {
    const req = this.requests.get(details.requestId);
    if (req) {
      req.statusCode = details.statusCode;
      req.statusLine = details.statusLine;
      if (details.responseHeaders) {
        req.responseHeaders = {};
        for (const header of details.responseHeaders) {
          if (header.name && header.value) {
            req.responseHeaders[header.name] = header.value;
          }
        }
      }
    }
  }

  /** Record the error string when a request fails (network error, abort, etc.). */
  private _handleError(details: chrome.webRequest.WebResponseErrorDetails): void {
    const req = this.requests.get(details.requestId);
    if (req) {
      req.error = details.error;
    }
  }
}
