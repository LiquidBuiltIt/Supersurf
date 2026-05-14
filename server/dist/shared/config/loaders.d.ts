import type { PartialConfig } from './types';
export interface LoadResult {
    config: PartialConfig;
    warnings: string[];
}
export declare function loadJsonConfig(filePath: string): LoadResult;
export declare function loadEnvConfig(env: Record<string, string | undefined>): LoadResult;
//# sourceMappingURL=loaders.d.ts.map