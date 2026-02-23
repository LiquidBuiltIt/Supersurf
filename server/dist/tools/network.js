"use strict";
/**
 * Network and console tool handlers.
 *
 * Implements `browser_network_requests` (list/details/replay/clear captured
 * HTTP traffic) and `browser_console_messages` (read page console output).
 *
 * Network requests are captured by the extension's webRequest listener and
 * stored in-memory. Filtering is applied server-side after retrieval.
 *
 * @module tools/network
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.onNetworkRequests = onNetworkRequests;
exports.onConsoleMessages = onConsoleMessages;
/**
 * List, inspect, replay, or clear captured network requests.
 *
 * Actions:
 * - `list` (default): Paginated list with optional URL/method/status/type filters
 * - `details`: Full details for a specific requestId
 * - `replay`: Re-send a captured request via page-context fetch()
 * - `clear`: Clear the captured request log
 *
 * @param args - `{ action?, urlPattern?, method?, status?, resourceType?, limit?, offset?, requestId?, jsonPath? }`
 */
async function onNetworkRequests(ctx, args, options) {
    const action = args.action || 'list';
    if (action === 'clear') {
        await ctx.ext.sendCmd('clearNetwork', {});
        if (options.rawResult)
            return { success: true };
        return { content: [{ type: 'text', text: 'Network requests cleared' }] };
    }
    const result = await ctx.ext.sendCmd('networkRequests', {});
    let requests = result?.requests || [];
    // Apply filters
    if (args.urlPattern) {
        requests = requests.filter((r) => r.url?.includes(args.urlPattern));
    }
    if (args.method) {
        requests = requests.filter((r) => r.method === args.method);
    }
    if (args.status) {
        requests = requests.filter((r) => r.statusCode === args.status);
    }
    if (args.resourceType) {
        requests = requests.filter((r) => r.type === args.resourceType);
    }
    if (action === 'details' && args.requestId) {
        const req = requests.find((r) => r.requestId === args.requestId);
        if (!req)
            return ctx.error(`Request not found: \`${args.requestId}\`\n\nUse \`action='list'\` to see available request IDs.`, options);
        if (options.rawResult)
            return req;
        return { content: [{ type: 'text', text: JSON.stringify(req, null, 2) }] };
    }
    if (action === 'replay' && args.requestId) {
        const req = requests.find((r) => r.requestId === args.requestId);
        if (!req)
            return ctx.error(`Request not found: \`${args.requestId}\`\n\nUse \`action='list'\` to see available request IDs.`, options);
        const replayResult = await ctx.eval(`
      fetch(${JSON.stringify(req.url)}, {
        method: ${JSON.stringify(req.method || 'GET')},
        ${req.postData ? `body: ${JSON.stringify(req.postData)},` : ''}
      }).then(r => r.text().then(body => ({ status: r.status, statusText: r.statusText, body })))
    `);
        if (options.rawResult)
            return replayResult;
        return { content: [{ type: 'text', text: `Replay: ${replayResult?.status} ${replayResult?.statusText}\n\n${replayResult?.body?.substring(0, 2000) || ''}` }] };
    }
    // List (default)
    const limit = args.limit || 20;
    const offset = args.offset || 0;
    const total = requests.length;
    requests = requests.slice(offset, offset + limit);
    if (options.rawResult)
        return { requests, total, offset, limit };
    if (requests.length === 0) {
        return { content: [{ type: 'text', text: 'No network requests captured' }] };
    }
    let text = `### Network Requests (${total} total)\n\n`;
    requests.forEach((r, i) => {
        const status = r.statusCode || '...';
        text += `${offset + i + 1}. [${status}] ${r.method || 'GET'} ${r.url}\n`;
    });
    return { content: [{ type: 'text', text }] };
}
/**
 * Read captured console messages from the page, with optional filtering.
 *
 * @param args - `{ level?, text?, url?, limit?, offset? }`
 */
async function onConsoleMessages(ctx, args, options) {
    const result = await ctx.ext.sendCmd('consoleMessages', {});
    let messages = result?.messages || [];
    // Apply filters
    if (args.level)
        messages = messages.filter((m) => m.level === args.level);
    if (args.text) {
        const textLower = args.text.toLowerCase();
        messages = messages.filter((m) => m.text?.toLowerCase().includes(textLower));
    }
    if (args.url) {
        messages = messages.filter((m) => m.url?.includes(args.url));
    }
    // Paginate
    const limit = args.limit || 50;
    const offset = args.offset || 0;
    messages = messages.slice(offset, offset + limit);
    if (options.rawResult)
        return { messages, total: result?.messages?.length || 0 };
    if (messages.length === 0) {
        return { content: [{ type: 'text', text: 'No console messages' }] };
    }
    const text = messages.map((m) => `[${m.level || 'log'}] ${m.text || ''}`).join('\n');
    return { content: [{ type: 'text', text }] };
}
//# sourceMappingURL=network.js.map