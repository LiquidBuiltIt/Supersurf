import type { Config, PartialConfig, ConfigSource } from './types';
export interface ConfigInputs {
    cli: PartialConfig;
    env: PartialConfig;
    file: PartialConfig;
    onWarn?: (msg: string) => void;
}
type LeafPath = string;
export declare class ConfigService {
    private resolved;
    private sources;
    constructor(inputs: ConfigInputs);
    get(): Config;
    sourceOf(path: LeafPath): ConfigSource;
    private validateKnownKeys;
    private pick;
    private merge;
}
export {};
//# sourceMappingURL=service.d.ts.map