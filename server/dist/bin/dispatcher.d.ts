export type Target = 'mcp' | 'daemon' | 'profiles' | 'creds' | 'help';
export interface DispatchPlan {
    target: Target;
    remainingArgv: string[];
}
export declare const HELP_TEXT = "supersurf \u2014 MCP browser automation for AI agents\n\nUsage: supersurf <command> [options]\n\nCommands:\n  mcp       Start the MCP server over stdio (the agent entrypoint)\n  daemon    Manage the coordinator daemon: start | stop | restart | status | observe\n  profiles  Manage browser profiles: ls | open <name>\n\nExamples:\n  npx supersurf-mcp@latest mcp\n  supersurf daemon status\n  supersurf profiles open dev";
export declare function pickTarget(argv: string[]): DispatchPlan;
export declare function dispatch(argv: string[]): Promise<void>;
//# sourceMappingURL=dispatcher.d.ts.map