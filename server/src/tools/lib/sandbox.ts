/**
 * Path sandboxing for agent-controlled file writes.
 *
 * Relative paths are resolved against $HOME. Absolute paths are honored
 * as-is when they already live inside $HOME. Any path — absolute or
 * relative-via-`..` — that resolves outside $HOME is rejected with a
 * clear, actionable error rather than being silently relocated.
 *
 * @module tools/sandbox
 */

import os from 'os';
import path from 'path';

const OUT_OF_JAIL_ERROR =
  'Path must be inside your home directory. Use a relative path (resolved from $HOME) or an absolute path under $HOME.';

/**
 * Resolve an agent-supplied path safely within $HOME.
 *
 * - Absolute paths already inside $HOME (e.g. `$HOME/Desktop/file.png`) are
 *   returned as-is, normalized via `path.resolve`.
 * - Relative paths like `Desktop/file.png` resolve to `$HOME/Desktop/file.png`.
 * - Absolute paths outside $HOME, and any path (including `..` traversal)
 *   that resolves outside $HOME, throw a clear error instead of being
 *   silently rewritten.
 *
 * @param userPath - Raw path string from agent input
 * @returns Resolved absolute path guaranteed to be within $HOME
 * @throws Error if the path resolves outside $HOME
 */
export function sandboxPath(userPath: string): string {
  const home = os.homedir();

  const resolved = path.isAbsolute(userPath)
    ? path.resolve(userPath)
    : path.resolve(home, userPath);

  // Ensure the resolved path is within $HOME
  if (!resolved.startsWith(home + path.sep) && resolved !== home) {
    throw new Error(OUT_OF_JAIL_ERROR);
  }

  return resolved;
}
