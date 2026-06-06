#!/usr/bin/env node
import { Command } from 'commander';
import type { KeychainBackend } from 'shared';
export interface RunOpts {
    backend?: KeychainBackend;
    readSecret?: () => Promise<string>;
    log?: (msg: string) => void;
}
export declare function buildCredsProgram(): Command;
export declare function runAdd(name: string, domain?: string, opts?: RunOpts): Promise<void>;
export declare function runList(opts?: RunOpts): Promise<void>;
export declare function runRemove(name: string, opts?: RunOpts): Promise<void>;
export declare function runCredsProgram(argv: string[]): Promise<void>;
//# sourceMappingURL=creds.d.ts.map