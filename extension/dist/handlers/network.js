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
    browser;
    logger;
    /** Ring buffer keyed by requestId. Insertion order = chronological order. */
    requests = new Map();
    constructor(browserAPI, logger) {
        this.browser = browserAPI;
        this.logger = logger;
    }
    /** Register webRequest listeners for all URLs. Must be called once after construction. */
    init() {
        const filter = { urls: ['<all_urls>'] };
        this.browser.webRequest.onBeforeRequest.addListener((details) => this._handleBeforeRequest(details), filter, ['requestBody']);
        this.browser.webRequest.onBeforeSendHeaders.addListener((details) => this._handleBeforeSendHeaders(details), filter, ['requestHeaders']);
        this.browser.webRequest.onCompleted.addListener((details) => this._handleCompleted(details), filter, ['responseHeaders']);
        this.browser.webRequest.onErrorOccurred.addListener((details) => this._handleError(details), filter);
    }
    /** Return all tracked requests as an array, ordered oldest-first. */
    getRequests() {
        return Array.from(this.requests.values());
    }
    clearRequests() {
        this.requests.clear();
    }
    /** Create initial entry on request start, evicting oldest if at capacity. */
    _handleBeforeRequest(details) {
        // Trim to max
        if (this.requests.size >= MAX_REQUESTS) {
            const oldest = this.requests.keys().next().value;
            if (oldest)
                this.requests.delete(oldest);
        }
        this.requests.set(details.requestId, {
            requestId: details.requestId,
            url: details.url,
            method: details.method,
            type: details.type,
            timestamp: details.timeStamp,
            requestBody: details.requestBody || undefined,
        });
    }
    /** Attach request headers (flattened from Chrome's array format to a plain object). */
    _handleBeforeSendHeaders(details) {
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
    _handleCompleted(details) {
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
    _handleError(details) {
        const req = this.requests.get(details.requestId);
        if (req) {
            req.error = details.error;
        }
    }
}
