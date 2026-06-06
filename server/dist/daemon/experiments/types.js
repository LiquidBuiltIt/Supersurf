"use strict";
/**
 * IPC message types for experiment operations.
 *
 * These are daemon-level IPC messages handled directly by the IPC server,
 * NOT forwarded to the extension via the scheduler.
 *
 * @module experiments/types
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isExperimentMethod = isExperimentMethod;
/** Check if a JSON-RPC method is an experiment IPC message. */
function isExperimentMethod(method) {
    return method === 'experiments.toggle'
        || method === 'experiments.get'
        || method === 'experiments.getOne';
}
//# sourceMappingURL=types.js.map