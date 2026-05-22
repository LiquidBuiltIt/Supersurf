import type { DebugMode } from '../logger/logger';
export interface Config {
    experiments: {
        page_diffing: boolean;
        smart_waiting: boolean;
        storage_inspection: boolean;
        mouse_humanization: boolean;
    };
    security: {
        secure_eval: boolean;
        domain_whitelist: {
            enabled: boolean;
            mode: 'tranco' | 'custom' | 'both';
            custom: string[];
        };
    };
    daemon: {
        port: number;
        idle_timeout_ms: number;
    };
    logging: {
        debug: DebugMode;
        usage_metrics: boolean;
    };
    tips: boolean;
}
export type PartialConfig = {
    experiments?: Partial<Config['experiments']>;
    security?: {
        secure_eval?: boolean;
        domain_whitelist?: Partial<Config['security']['domain_whitelist']>;
    };
    daemon?: Partial<Config['daemon']>;
    logging?: Partial<Config['logging']>;
    tips?: boolean;
};
export type ConfigSource = 'cli' | 'env' | 'file' | 'default';
//# sourceMappingURL=types.d.ts.map