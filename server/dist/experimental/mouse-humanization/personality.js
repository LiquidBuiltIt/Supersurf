"use strict";
/**
 * MousePersonality — per-session behavioral fingerprint.
 *
 * Each session gets a unique personality generated once at init. These traits
 * modulate the path generator's output so that different sessions produce
 * distinct but consistently human-like movement patterns.
 *
 * Ranges are hand-tuned to fall within human-plausible bounds observed in
 * the Balabit Mouse Dynamics dataset.
 *
 * @module experimental/mouse-humanization/personality
 *
 * Key exports:
 * - {@link MousePersonality} — trait interface
 * - {@link generatePersonality} — random personality factory
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.generatePersonality = generatePersonality;
/**
 * Generate a random personality within human-plausible ranges.
 * Called once per session init.
 */
function generatePersonality() {
    return {
        speedMultiplier: 0.7 + Math.random() * 0.6, // 0.7–1.3
        overshootTendency: 0.3 + Math.random() * 0.5, // 0.3–0.8
        curvatureBias: 0.3 + Math.random() * 0.4, // 0.3–0.7
        jitterPx: 0.5 + Math.random() * 1.5, // 0.5–2.0
    };
}
//# sourceMappingURL=personality.js.map