"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCAFFOLD_DEFAULTS = exports.HARDCODED_DEFAULTS = void 0;
exports.HARDCODED_DEFAULTS = {
    experiments: {
        page_diffing: false,
        smart_waiting: false,
        mouse_humanization: false,
        fingerprinting: false,
    },
    security: {
        secure_eval: true,
        playbook_eval: true,
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
    profiles: {
        chrome_path: null,
        startup_opts: {
            disable_gpu: false,
        },
    },
    screenshot: {
        omit_path: 'inline',
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
    profiles: {
        chrome_path: exports.HARDCODED_DEFAULTS.profiles.chrome_path,
        startup_opts: { ...exports.HARDCODED_DEFAULTS.profiles.startup_opts },
    },
    screenshot: { ...exports.HARDCODED_DEFAULTS.screenshot },
};
//# sourceMappingURL=defaults.js.map