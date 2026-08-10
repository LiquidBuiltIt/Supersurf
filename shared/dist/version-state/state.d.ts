/** Default location of the version-state file: `~/.supersurf/version-state.json`. */
export declare function defaultVersionStatePath(): string;
/**
 * True only when both versions parse as semver-ish `x.y.z` and the current
 * major is strictly greater than the last-recorded major. Same-major
 * minor/patch bumps, downgrades, and unparsable input are all false.
 */
export declare function shouldShowUpgradeNotice(lastVersion: string | null, currentVersion: string): boolean;
export interface VersionCheckResult {
    shouldNotify: boolean;
}
/**
 * Read the version-state file, decide whether to show the major-version
 * upgrade notice, then record the current version + timestamp. Never
 * throws: any FS/parse error is treated as "no notice" (first-run behavior)
 * and the write is best-effort.
 */
export declare function checkAndTouchVersionState(currentVersion: string, filePath?: string): VersionCheckResult;
//# sourceMappingURL=state.d.ts.map