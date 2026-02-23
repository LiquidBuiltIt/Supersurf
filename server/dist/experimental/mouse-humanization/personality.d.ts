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
export interface MousePersonality {
    /** Multiplier on base velocity (0.7 = slower, 1.3 = faster) */
    speedMultiplier: number;
    /** Tendency to overshoot (0 = never, 1 = always when above threshold) */
    overshootTendency: number;
    /** Curvature bias — how much the path bows (0.5 = neutral, 0 = straight, 1 = very curved) */
    curvatureBias: number;
    /** Jitter magnitude in px — micro-tremor on waypoints */
    jitterPx: number;
}
/**
 * Generate a random personality within human-plausible ranges.
 * Called once per session init.
 */
export declare function generatePersonality(): MousePersonality;
//# sourceMappingURL=personality.d.ts.map