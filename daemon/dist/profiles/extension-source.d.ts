/**
 * Extension source management — downloads and caches the SuperSurf extension
 * from GitHub for use with managed Chromium profiles.
 *
 * First run: pulls from GitHub and caches to ~/.supersurf/extension/.
 * Subsequent runs: checks GitHub for updates (non-blocking). If the network
 * is unreachable, the cached version is used as-is.
 *
 * @module profiles/extension-source
 */
/** The extension dir managed profiles load: a dev clone's, else the cached release. */
export declare function getExtensionDir(): string;
/** Check if the extension is present (manifest.json exists). */
export declare function isExtensionCached(): boolean;
/** Fetch the latest tag name from the GitHub repo. */
export declare function getLatestTag(): Promise<string>;
/** Pull the extension from GitHub tarball and extract to ~/.supersurf/extension/. */
export declare function pullExtension(tag?: string): Promise<void>;
/**
 * Ensure the extension is cached locally and up to date.
 *
 * - Not cached: pull from GitHub (required for first-time setup)
 * - Cached: check GitHub for newer version (non-blocking — if network
 *   fails, the cached version is used)
 */
export declare function ensureExtension(): Promise<void>;
//# sourceMappingURL=extension-source.d.ts.map