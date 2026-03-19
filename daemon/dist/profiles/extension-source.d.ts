/**
 * Extension source management — downloads and caches the SuperSurf extension
 * from GitHub for use with managed Chromium profiles.
 *
 * @module profiles/extension-source
 */
/** Get the cached extension directory path. */
export declare function getExtensionDir(): string;
/** Check if the extension is already cached (manifest.json exists). */
export declare function isExtensionCached(): boolean;
/** Fetch the latest tag name from the GitHub repo. */
export declare function getLatestTag(): Promise<string>;
/** Pull the extension from GitHub tarball and extract to ~/.supersurf/extension/. */
export declare function pullExtension(tag?: string): Promise<void>;
/** Ensure the extension is cached locally and up to date. Pulls from GitHub if missing or stale. */
export declare function ensureExtension(): Promise<void>;
//# sourceMappingURL=extension-source.d.ts.map