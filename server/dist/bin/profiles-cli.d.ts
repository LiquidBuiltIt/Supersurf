export declare const PROFILES_USAGE = "supersurf profiles \u2014 manage browser profiles\n\nUsage: supersurf profiles <command>\n\nCommands:\n  ls             List profiles and their state\n  open <name>    Launch a profile's Chromium (user-owned: survives agent\n                 sessions and daemon restarts; close the window to end it)";
export type ProfilesCommand = {
    cmd: 'ls';
} | {
    cmd: 'open';
    profile: string;
} | {
    cmd: 'help';
    error?: string;
};
export declare function parseProfilesArgs(argv: string[]): ProfilesCommand;
export declare function runProfilesCli(argv: string[]): Promise<void>;
//# sourceMappingURL=profiles-cli.d.ts.map