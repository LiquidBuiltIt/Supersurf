import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockChrome } from '../__mocks__/chrome';
import { NetworkTracker } from '../../src/handlers/network';

function createMockLogger() {
  return {
    log: vi.fn(),
    logAlways: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    setDebugMode: vi.fn(),
  } as any;
}

describe('NetworkTracker', () => {
  let mockChrome: ReturnType<typeof createMockChrome>;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let tracker: NetworkTracker;

  beforeEach(() => {
    mockChrome = createMockChrome();
    mockLogger = createMockLogger();
    tracker = new NetworkTracker(mockChrome, mockLogger);
  });

  describe('init()', () => {
    it('registers onBeforeRequest listener', () => {
      tracker.init();
      expect(mockChrome.webRequest.onBeforeRequest.addListener).toHaveBeenCalledTimes(1);
    });

    it('registers onBeforeSendHeaders listener', () => {
      tracker.init();
      expect(mockChrome.webRequest.onBeforeSendHeaders.addListener).toHaveBeenCalledTimes(1);
    });

    it('registers onCompleted listener', () => {
      tracker.init();
      expect(mockChrome.webRequest.onCompleted.addListener).toHaveBeenCalledTimes(1);
    });

    it('registers onErrorOccurred listener', () => {
      tracker.init();
      expect(mockChrome.webRequest.onErrorOccurred.addListener).toHaveBeenCalledTimes(1);
    });

    it('passes the correct URL filter to all listeners', () => {
      tracker.init();

      const expectedFilter = { urls: ['<all_urls>'] };

      // onBeforeRequest
      const beforeReqArgs = mockChrome.webRequest.onBeforeRequest.addListener.mock.calls[0];
      expect(beforeReqArgs[1]).toEqual(expectedFilter);
      expect(beforeReqArgs[2]).toEqual(['requestBody']);

      // onBeforeSendHeaders
      const beforeHeadersArgs = mockChrome.webRequest.onBeforeSendHeaders.addListener.mock.calls[0];
      expect(beforeHeadersArgs[1]).toEqual(expectedFilter);
      expect(beforeHeadersArgs[2]).toEqual(['requestHeaders']);

      // onCompleted
      const completedArgs = mockChrome.webRequest.onCompleted.addListener.mock.calls[0];
      expect(completedArgs[1]).toEqual(expectedFilter);
      expect(completedArgs[2]).toEqual(['responseHeaders']);

      // onErrorOccurred
      const errorArgs = mockChrome.webRequest.onErrorOccurred.addListener.mock.calls[0];
      expect(errorArgs[1]).toEqual(expectedFilter);
    });
  });

  describe('request tracking via events', () => {
    it('tracks requests from onBeforeRequest events', () => {
      tracker.init();

      mockChrome.webRequest.onBeforeRequest._fire({
        requestId: 'req-1',
        url: 'https://api.example.com/data',
        method: 'GET',
        type: 'xmlhttprequest',
        timeStamp: 1000,
      });

      const requests = tracker.getRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toEqual({
        requestId: 'req-1',
        url: 'https://api.example.com/data',
        method: 'GET',
        type: 'xmlhttprequest',
        timestamp: 1000,
        requestBody: undefined,
      });
    });

    it('includes requestBody when present', () => {
      tracker.init();

      mockChrome.webRequest.onBeforeRequest._fire({
        requestId: 'req-2',
        url: 'https://api.example.com/submit',
        method: 'POST',
        type: 'xmlhttprequest',
        timeStamp: 2000,
        requestBody: { formData: { name: ['test'] } },
      });

      const requests = tracker.getRequests();
      expect(requests[0].requestBody).toEqual({ formData: { name: ['test'] } });
    });

    it('updates headers from onBeforeSendHeaders events', () => {
      tracker.init();

      // First create the request
      mockChrome.webRequest.onBeforeRequest._fire({
        requestId: 'req-3',
        url: 'https://example.com',
        method: 'GET',
        type: 'main_frame',
        timeStamp: 3000,
      });

      // Then update headers
      mockChrome.webRequest.onBeforeSendHeaders._fire({
        requestId: 'req-3',
        requestHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Authorization', value: 'Bearer token123' },
        ],
      });

      const requests = tracker.getRequests();
      expect(requests[0].requestHeaders).toEqual({
        'Content-Type': 'application/json',
        'Authorization': 'Bearer token123',
      });
    });

    it('ignores headers for unknown request IDs', () => {
      tracker.init();

      mockChrome.webRequest.onBeforeSendHeaders._fire({
        requestId: 'unknown',
        requestHeaders: [{ name: 'X-Test', value: 'value' }],
      });

      expect(tracker.getRequests()).toHaveLength(0);
    });

    it('skips headers without name or value', () => {
      tracker.init();

      mockChrome.webRequest.onBeforeRequest._fire({
        requestId: 'req-4',
        url: 'https://example.com',
        method: 'GET',
        type: 'main_frame',
        timeStamp: 4000,
      });

      mockChrome.webRequest.onBeforeSendHeaders._fire({
        requestId: 'req-4',
        requestHeaders: [
          { name: 'Valid', value: 'yes' },
          { name: '', value: 'empty-name' },
          { name: 'No-Value' },
        ],
      });

      const requests = tracker.getRequests();
      expect(requests[0].requestHeaders).toEqual({ Valid: 'yes' });
    });

    it('updates status from onCompleted events', () => {
      tracker.init();

      mockChrome.webRequest.onBeforeRequest._fire({
        requestId: 'req-5',
        url: 'https://example.com',
        method: 'GET',
        type: 'main_frame',
        timeStamp: 5000,
      });

      mockChrome.webRequest.onCompleted._fire({
        requestId: 'req-5',
        statusCode: 200,
        statusLine: 'HTTP/1.1 200 OK',
        responseHeaders: [
          { name: 'Content-Type', value: 'text/html' },
        ],
      });

      const requests = tracker.getRequests();
      expect(requests[0].statusCode).toBe(200);
      expect(requests[0].statusLine).toBe('HTTP/1.1 200 OK');
      expect(requests[0].responseHeaders).toEqual({
        'Content-Type': 'text/html',
      });
    });

    it('records errors from onErrorOccurred events', () => {
      tracker.init();

      mockChrome.webRequest.onBeforeRequest._fire({
        requestId: 'req-6',
        url: 'https://bad.example.com',
        method: 'GET',
        type: 'main_frame',
        timeStamp: 6000,
      });

      mockChrome.webRequest.onErrorOccurred._fire({
        requestId: 'req-6',
        error: 'net::ERR_CONNECTION_REFUSED',
      });

      const requests = tracker.getRequests();
      expect(requests[0].error).toBe('net::ERR_CONNECTION_REFUSED');
    });

    it('ignores errors for unknown request IDs', () => {
      tracker.init();

      mockChrome.webRequest.onErrorOccurred._fire({
        requestId: 'unknown',
        error: 'net::ERR_FAILED',
      });

      expect(tracker.getRequests()).toHaveLength(0);
    });
  });

  describe('getRequests()', () => {
    it('returns all tracked requests', () => {
      tracker.init();

      mockChrome.webRequest.onBeforeRequest._fire({
        requestId: 'a',
        url: 'https://a.com',
        method: 'GET',
        type: 'main_frame',
        timeStamp: 100,
      });

      mockChrome.webRequest.onBeforeRequest._fire({
        requestId: 'b',
        url: 'https://b.com',
        method: 'POST',
        type: 'xmlhttprequest',
        timeStamp: 200,
      });

      const requests = tracker.getRequests();
      expect(requests).toHaveLength(2);
      expect(requests[0].url).toBe('https://a.com');
      expect(requests[1].url).toBe('https://b.com');
    });

    it('returns empty array when no requests tracked', () => {
      expect(tracker.getRequests()).toHaveLength(0);
    });
  });

  describe('clearRequests()', () => {
    it('empties the requests map', () => {
      tracker.init();

      mockChrome.webRequest.onBeforeRequest._fire({
        requestId: 'r1',
        url: 'https://example.com',
        method: 'GET',
        type: 'main_frame',
        timeStamp: 1,
      });

      expect(tracker.getRequests()).toHaveLength(1);

      tracker.clearRequests();
      expect(tracker.getRequests()).toHaveLength(0);
    });
  });

  describe('tab scoping', () => {
    // One Chrome profile has one webRequest stream, so without a tabId on each
    // entry every session reads every other session's traffic. These four cases
    // are the whole contract; the cross-session proof is scripts/smoke-parallel.ts.
    function fireOn(tabId: number, requestId: string, url: string) {
      mockChrome.webRequest.onBeforeRequest._fire({
        requestId,
        tabId,
        url,
        method: 'GET',
        type: 'main_frame',
        timeStamp: 1,
      });
    }

    beforeEach(() => {
      tracker.init();
      fireOn(7, 'a', 'https://a.com');
      fireOn(9, 'b', 'https://b.com');
      fireOn(7, 'c', 'https://c.com');
    });

    it('getRequests(tabId) returns only that tab\'s requests', () => {
      expect(tracker.getRequests(7).map(r => r.url)).toEqual(['https://a.com', 'https://c.com']);
      expect(tracker.getRequests(9).map(r => r.url)).toEqual(['https://b.com']);
    });

    it('getRequests() with no tabId still returns every request', () => {
      expect(tracker.getRequests()).toHaveLength(3);
    });

    it('clearRequests(tabId) leaves the other tab\'s requests alone', () => {
      tracker.clearRequests(7);
      expect(tracker.getRequests().map(r => r.url)).toEqual(['https://b.com']);
    });

    it('records the owning tabId on each tracked request', () => {
      expect(tracker.getRequests().map(r => r.tabId)).toEqual([7, 9, 7]);
    });
  });

  describe('MAX_REQUESTS enforcement (500)', () => {
    it('evicts oldest request when limit is reached', () => {
      tracker.init();

      // Fill to the max
      for (let i = 0; i < 500; i++) {
        mockChrome.webRequest.onBeforeRequest._fire({
          requestId: `req-${i}`,
          url: `https://example.com/${i}`,
          method: 'GET',
          type: 'main_frame',
          timeStamp: i,
        });
      }

      expect(tracker.getRequests()).toHaveLength(500);

      // Add one more
      mockChrome.webRequest.onBeforeRequest._fire({
        requestId: 'req-500',
        url: 'https://example.com/500',
        method: 'GET',
        type: 'main_frame',
        timeStamp: 500,
      });

      const requests = tracker.getRequests();
      expect(requests).toHaveLength(500);

      // Oldest (req-0) should be gone
      const ids = requests.map((r) => r.requestId);
      expect(ids).not.toContain('req-0');
      expect(ids).toContain('req-500');
      expect(ids).toContain('req-1');
    });
  });
});
