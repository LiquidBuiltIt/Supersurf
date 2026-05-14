"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCAFFOLD_DEFAULTS = exports.HARDCODED_DEFAULTS = void 0;
exports.HARDCODED_DEFAULTS = {
    experiments: {
        page_diffing: false,
        smart_waiting: false,
        storage_inspection: false,
        mouse_humanization: false,
        profiles: false,
    },
    security: {
        secure_eval: true,
        domain_whitelist: {
            enabled: false,
            mode: 'tranco',
            custom: [],
        },
    },
    daemon: {
        port: 5555,
        idle_timeout_ms: 10 * 60 * 1000,
    },
    logging: {
        debug: false,
        usage_metrics: false,
    },
    tips: true,
};
exports.SCAFFOLD_DEFAULTS = {
    ...exports.HARDCODED_DEFAULTS,
    experiments: { ...exports.HARDCODED_DEFAULTS.experiments },
    security: {
        ...exports.HARDCODED_DEFAULTS.security,
        domain_whitelist: { ...exports.HARDCODED_DEFAULTS.security.domain_whitelist, custom: [] },
    },
    daemon: { ...exports.HARDCODED_DEFAULTS.daemon },
    logging: { ...exports.HARDCODED_DEFAULTS.logging, usage_metrics: true },
};
//# sourceMappingURL=defaults.js.map