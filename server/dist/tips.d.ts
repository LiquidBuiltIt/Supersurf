/**
 * Targeted tool tips — contextual hints appended to tool responses
 * when an agent uses a tool in a way that a better-suited tool handles.
 *
 * Each tip has a priority (lower = higher priority). When multiple tips
 * match, only the highest-priority tip is returned.
 *
 * @module tips
 */
export declare function clearTipCounters(sessionId: string): void;
export declare function getTip(tool: string, params: Record<string, unknown>, result: 'ok' | 'error', error?: string, sessionId?: string): string | null;
//# sourceMappingURL=tips.d.ts.map