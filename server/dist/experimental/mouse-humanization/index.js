"use strict";
/**
 * Mouse humanization session orchestrator.
 *
 * Each MCP session gets its own humanization session with a random personality
 * (speed, overshoot tendency, curvature, jitter) and tracked cursor position.
 * When a mouse movement is requested, this module delegates to the path generator
 * and updates the session's cursor state.
 *
 * Lifecycle: initSession() on experiment enable -> generateMovement() per interaction -> destroySession() on disable.
 *
 * @module experimental/mouse-humanization/index
 *
 * Key exports:
 * - {@link initSession} — create a session with a random personality
 * - {@link getSession} — retrieve session state
 * - {@link destroySession} — clean up on disconnect/disable
 * - {@link generateMovement} — produce a waypoint path from current cursor to target
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.generatePath = exports.generatePersonality = exports.BALABIT_PROFILE = void 0;
exports.initSession = initSession;
exports.getSession = getSession;
exports.destroySession = destroySession;
exports.generateMovement = generateMovement;
const profile_1 = require("./profile");
const personality_1 = require("./personality");
const generator_1 = require("./generator");
const logger_1 = require("../../logger");
const log = (0, logger_1.createLog)('[Mouse]');
var profile_2 = require("./profile");
Object.defineProperty(exports, "BALABIT_PROFILE", { enumerable: true, get: function () { return profile_2.BALABIT_PROFILE; } });
var personality_2 = require("./personality");
Object.defineProperty(exports, "generatePersonality", { enumerable: true, get: function () { return personality_2.generatePersonality; } });
var generator_2 = require("./generator");
Object.defineProperty(exports, "generatePath", { enumerable: true, get: function () { return generator_2.generatePath; } });
/** Active humanization sessions keyed by session ID. */
const sessions = new Map();
/** Initialize a new humanization session with a random personality. */
function initSession(sessionId, profile) {
    const personality = (0, personality_1.generatePersonality)();
    sessions.set(sessionId, {
        personality,
        cursorX: 0,
        cursorY: 0,
        profile: profile ?? profile_1.BALABIT_PROFILE,
    });
    log(`Session "${sessionId}" initialized — speed=${personality.speedMultiplier.toFixed(2)}, overshoot=${personality.overshootTendency.toFixed(2)}, curvature=${personality.curvatureBias.toFixed(2)}, jitter=${personality.jitterPx.toFixed(2)}px`);
}
/** Get a session, returns undefined if not initialized. */
function getSession(sessionId) {
    return sessions.get(sessionId);
}
/** Destroy a session on disable/disconnect. */
function destroySession(sessionId) {
    sessions.delete(sessionId);
    log(`Session "${sessionId}" destroyed`);
}
/**
 * Generate a humanized mouse movement path for a session.
 * Updates the session's cursor position to the target.
 */
function generateMovement(sessionId, targetX, targetY, viewport) {
    const session = sessions.get(sessionId);
    if (!session) {
        throw new Error(`No humanization session for "${sessionId}"`);
    }
    const fromX = session.cursorX;
    const fromY = session.cursorY;
    const dx = targetX - fromX;
    const dy = targetY - fromY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const waypoints = (0, generator_1.generatePath)(fromX, fromY, targetX, targetY, session.profile, session.personality, viewport);
    const overshoot = distance > session.profile.overshootThreshold;
    log(`Path (${fromX},${fromY})→(${targetX},${targetY}) dist=${Math.round(distance)}px waypoints=${waypoints.length} overshoot=${overshoot}`);
    // Update cursor position
    session.cursorX = targetX;
    session.cursorY = targetY;
    return waypoints;
}
//# sourceMappingURL=index.js.map