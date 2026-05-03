/**
 * Path sandboxing for agent-controlled file writes.
 *
 * All paths from agent input are resolved relative to $HOME.
 * Traversal outside $HOME is rejected with a generic error
 * to prevent information leakage about the filesystem.
 *
 * @module tools/sandbox
 */
/**
 * Resolve an agent-supplied path safely within $HOME.
 *
 * - Absolute paths like `/etc/foo` become `$HOME/etc/foo`
 * - Relative paths like `Desktop/file.png` resolve to `$HOME/Desktop/file.png`
 * - Traversal via `..` that escapes $HOME throws "Permission denied"
 *
 * @param userPath - Raw path string from agent input
 * @returns Resolved absolute path guaranteed to be within $HOME
 * @throws Error with "Permission denied" if path escapes $HOME
 */
export declare function sandboxPath(userPath: string): string;
//# sourceMappingURL=sandbox.d.ts.map