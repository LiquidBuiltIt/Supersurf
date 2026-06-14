export type Target = 'mcp' | 'daemon' | 'creds' | 'help';
export interface DispatchPlan {
    target: Target;
    remainingArgv: string[];
}
export declare const HELP_TEXT = "supersurf \u2014 MCP browser automation for AI agents\n\nUsage: supersurf <command> [options]\n\nCommands:\n  mcp       Start the MCP server over stdio (the agent entrypoint)\n  daemon    Manage the coordinator daemon: start | stop | restart | status | observe\n\nExamples:\n  npx supersurf@latest mcp\n  supersurf daemon status";
export declare function pickTarget(argv: string[]): DispatchPlan;
export declare function dispatch(argv: string[]): Promise<void>;
//# sourceMappingURL=dispatcher.d.ts.map