/**
 * IPC message types for experiment operations.
 *
 * These are daemon-level IPC messages handled directly by the IPC server,
 * NOT forwarded to the extension via the scheduler.
 *
 * @module experiments/types
 */
export interface ExperimentToggleParams {
    experiment: string;
    enabled: boolean;
}
export interface ExperimentGetOneParams {
    experiment: string;
}
/** Check if a JSON-RPC method is an experiment IPC message. */
export declare function isExperimentMethod(method: string): boolean;
//# sourceMappingURL=types.d.ts.map