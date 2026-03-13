"use strict";
/**
 * Extension source management — downloads and caches the SuperSurf extension
 * from GitHub for use with managed Chromium profiles.
 *
 * @module profiles/extension-source
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getExtensionDir = getExtensionDir;
exports.isExtensionCached = isExtensionCached;
exports.getLatestTag = getLatestTag;
exports.pullExtension = pullExtension;
exports.ensureExtension = ensureExtension;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const https_1 = __importDefault(require("https"));
const child_process_1 = require("child_process");
const SUPERSURF_DIR = path_1.default.join(os_1.default.homedir(), '.supersurf');
const EXTENSION_DIR = path_1.default.join(SUPERSURF_DIR, 'extension');
const GITHUB_REPO = 'LiquidBuiltIt/Supersurf';
const debugLog = (...args) => {
    const logger = global.DAEMON_LOGGER;
    if (logger)
        logger.log('[ExtSrc]', ...args);
    else if (global.DAEMON_DEBUG)
        console.error('[ExtSrc]', ...args);
};
/** Get the cached extension directory path. */
function getExtensionDir() {
    return EXTENSION_DIR;
}
/** Check if the extension is already cached (manifest.json exists). */
function isExtensionCached() {
    return fs_1.default.existsSync(path_1.default.join(EXTENSION_DIR, 'manifest.json'));
}
/** Fetch the latest tag name from the GitHub repo. */
function getLatestTag() {
    return new Promise((resolve, reject) => {
        const url = `https://api.github.com/repos/${GITHUB_REPO}/tags`;
        const options = {
            headers: {
                'User-Agent': 'supersurf-daemon',
                'Accept': 'application/vnd.github.v3+json',
            },
        };
        https_1.default.get(url, options, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                reject(new Error(`GitHub API redirected (${res.statusCode})`));
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`GitHub API returned ${res.statusCode}`));
                return;
            }
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const tags = JSON.parse(data);
                    if (!Array.isArray(tags) || tags.length === 0) {
                        reject(new Error('No tags found in repository'));
                        return;
                    }
                    resolve(tags[0].name);
                }
                catch (err) {
                    reject(new Error(`Failed to parse GitHub tags: ${err.message}`));
                }
            });
        }).on('error', reject);
    });
}
/** Download a file from a URL to a local path. Follows redirects. */
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const request = (targetUrl) => {
            https_1.default.get(targetUrl, (res) => {
                // Follow redirects
                if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
                    res.resume(); // drain the response
                    request(res.headers.location);
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error(`Download failed: HTTP ${res.statusCode}`));
                    return;
                }
                const file = fs_1.default.createWriteStream(dest);
                res.pipe(file);
                file.on('finish', () => {
                    file.close();
                    resolve();
                });
                file.on('error', (err) => {
                    file.close();
                    try {
                        fs_1.default.unlinkSync(dest);
                    }
                    catch { }
                    reject(err);
                });
            }).on('error', (err) => {
                try {
                    fs_1.default.unlinkSync(dest);
                }
                catch { }
                reject(err);
            });
        };
        request(url);
    });
}
/** Pull the extension from GitHub tarball and extract to ~/.supersurf/extension/. */
async function pullExtension(tag) {
    if (!tag) {
        tag = await getLatestTag();
    }
    debugLog(`Pulling extension from tag: ${tag}`);
    const tarballUrl = `https://github.com/${GITHUB_REPO}/archive/refs/tags/${tag}.tar.gz`;
    const tmpDir = fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), 'supersurf-ext-'));
    const tarballPath = path_1.default.join(tmpDir, 'extension.tar.gz');
    try {
        await downloadFile(tarballUrl, tarballPath);
        debugLog('Tarball downloaded, extracting extension/ directory...');
        // Ensure extension directory exists and is clean
        if (fs_1.default.existsSync(EXTENSION_DIR)) {
            fs_1.default.rmSync(EXTENSION_DIR, { recursive: true });
        }
        fs_1.default.mkdirSync(EXTENSION_DIR, { recursive: true });
        // Extract only the extension/ subdirectory, stripping the top-level archive folder
        (0, child_process_1.execSync)(`tar xzf "${tarballPath}" --strip-components=1 -C "${EXTENSION_DIR}" "*/extension/"`, { stdio: 'pipe' });
        // The extraction puts files under EXTENSION_DIR/extension/ — move them up
        const nestedDir = path_1.default.join(EXTENSION_DIR, 'extension');
        if (fs_1.default.existsSync(nestedDir)) {
            const files = fs_1.default.readdirSync(nestedDir);
            for (const f of files) {
                fs_1.default.renameSync(path_1.default.join(nestedDir, f), path_1.default.join(EXTENSION_DIR, f));
            }
            fs_1.default.rmdirSync(nestedDir);
        }
        debugLog('Extension extracted to', EXTENSION_DIR);
    }
    finally {
        // Clean up temp files
        try {
            fs_1.default.rmSync(tmpDir, { recursive: true });
        }
        catch { }
    }
}
/** Ensure the extension is cached locally. Pulls from GitHub if not present. */
async function ensureExtension() {
    if (isExtensionCached()) {
        debugLog('Extension already cached at', EXTENSION_DIR);
        return;
    }
    debugLog('Extension not cached, pulling from GitHub...');
    await pullExtension();
}
//# sourceMappingURL=extension-source.js.map