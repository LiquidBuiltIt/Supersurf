"use strict";
/**
 * Type definitions for profile management.
 *
 * @module profiles/types
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isProfileMethod = isProfileMethod;
/** Check if a JSON-RPC method is a profile IPC message. */
function isProfileMethod(method) {
    return method === 'profiles.create'
        || method === 'profiles.list'
        || method === 'profiles.delete'
        || method === 'profiles.rename'
        || method === 'profiles.connect'
        || method === 'profiles.launch';
}
//# sourceMappingURL=types.js.map