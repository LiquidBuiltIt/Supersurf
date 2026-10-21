"use strict";
/**
 * Shared types for the backend module.
 *
 * Defines the configuration, state, and interface contracts used across
 * the AgentSession, handlers, and status builder. Kept in a separate
 * file to avoid circular imports between backend.ts and handlers.ts.
 *
 * @module backend/types
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isMultiAgent = isMultiAgent;
/** True when username-based multi-agent mode is on (`agents.multi_agent`). Off = 4.0.0 `client_id` semantics. */
function isMultiAgent(config) {
    return config.configService?.get().agents.multi_agent ?? false;
}
//# sourceMappingURL=types.js.map