"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.BALABIT_PROFILE = void 0;
/**
 * BALABIT_PROFILE — hand-tuned defaults based on Balabit Mouse Dynamics dataset.
 * Represents typical human mouse movement characteristics.
 */
exports.BALABIT_PROFILE = {
    medianVelocity: 180,
    velocitySigma: 0.4,
    overshootThreshold: 200,
    overshootRange: [0.05, 0.15],
    sampleIntervalMs: [15, 50],
    controlPointSpread: 0.3,
    idleDriftPx: [2, 5],
    idleDriftIntervalSec: [10, 30],
};
//# sourceMappingURL=profile.js.map