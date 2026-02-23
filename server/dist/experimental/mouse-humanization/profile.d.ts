/**
 * DistributionProfile — statistical parameters governing mouse movement generation.
 *
 * Defines the "physics" of cursor movement: velocity distribution, overshoot
 * behavior, sampling rate, curve shape, and idle drift. The interface is designed
 * to be swappable — the current BALABIT_PROFILE uses hand-tuned constants from
 * the Balabit Mouse Dynamics dataset, but can be replaced with dataset-driven
 * profiles (e.g. trained from BeCAPTCHA data) when available.
 *
 * @module experimental/mouse-humanization/profile
 *
 * Key exports:
 * - {@link DistributionProfile} — the parameter interface
 * - {@link BALABIT_PROFILE} — default hand-tuned profile
 */
export interface DistributionProfile {
    /** Median cursor velocity in px/sec */
    medianVelocity: number;
    /** Velocity log-normal sigma (spread around median) */
    velocitySigma: number;
    /** Distance threshold (px) above which overshoot is applied */
    overshootThreshold: number;
    /** Overshoot range as fraction of target distance [min, max] */
    overshootRange: [number, number];
    /** Time between waypoint samples in ms [min, max] */
    sampleIntervalMs: [number, number];
    /** Bezier control point spread factor — controls curvature */
    controlPointSpread: number;
    /** Idle drift magnitude in px [min, max] */
    idleDriftPx: [number, number];
    /** Idle drift interval in seconds [min, max] */
    idleDriftIntervalSec: [number, number];
}
/**
 * BALABIT_PROFILE — hand-tuned defaults based on Balabit Mouse Dynamics dataset.
 * Represents typical human mouse movement characteristics.
 */
export declare const BALABIT_PROFILE: DistributionProfile;
//# sourceMappingURL=profile.d.ts.map