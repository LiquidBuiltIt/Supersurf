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

import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import { execFileSync } from 'child_process';
import type { FileLogger } from 'shared';
import { devSource } from 'shared';

const SUPERSURF_DIR = path.join(os.homedir(), '.supersurf');
const EXTENSION_DIR = path.join(SUPERSURF_DIR, 'extension');
const GITHUB_REPO = 'LiquidBuiltIt/Supersurf';

const debugLog = (...args: unknown[]) => {
  const logger = (global as any).DAEMON_LOGGER as FileLogger | undefined;
  if (logger) logger.log('[ExtSrc]', ...args);
  else if ((global as any).DAEMON_DEBUG) console.error('[ExtSrc]', ...args);
};

/** The extension dir managed profiles load: a dev clone's, else the cached release. */
export function getExtensionDir(): string {
  return devSource('extension') ?? EXTENSION_DIR;
}

/** Check if the extension is present (manifest.json exists). */
export function isExtensionCached(): boolean {
  return fs.existsSync(path.join(getExtensionDir(), 'manifest.json'));
}

/** Read the version from the cached extension's manifest.json, or null if not present. */
function getCachedVersion(): string | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
    return manifest.version ?? null;
  } catch {
    return null;
  }
}

/** Fetch the latest tag name from the GitHub repo. */
export function getLatestTag(): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/tags`;
    const options = {
      headers: {
        'User-Agent': 'supersurf-daemon',
        'Accept': 'application/vnd.github.v3+json',
      },
    };

    https.get(url, options, (res) => {
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
        } catch (err: any) {
          reject(new Error(`Failed to parse GitHub tags: ${err.message}`));
        }
      });
    }).on('error', reject);
  });
}

/** Download a file from a URL to a local path. Follows redirects. */
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = (targetUrl: string) => {
      https.get(targetUrl, (res) => {
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
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
        file.on('error', (err) => {
          file.close();
          try { fs.unlinkSync(dest); } catch {}
          reject(err);
        });
      }).on('error', (err) => {
        try { fs.unlinkSync(dest); } catch {}
        reject(err);
      });
    };
    request(url);
  });
}

/**
 * Pull the extension from a GitHub tarball into ~/.supersurf/extension/.
 *
 * Atomic: the tarball is extracted into a staging dir beside the cache and
 * validated first; the old cache is only replaced once the new one is good,
 * so any failure leaves the previous extension untouched.
 */
export async function pullExtension(tag?: string): Promise<void> {
  if (!tag) {
    tag = await getLatestTag();
  }
  debugLog(`Pulling extension from tag: ${tag}`);

  const tarballUrl = `https://github.com/${GITHUB_REPO}/archive/refs/tags/${tag}.tar.gz`;
  fs.mkdirSync(SUPERSURF_DIR, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supersurf-ext-'));
  let stagingDir = '';
  const tarballPath = path.join(tmpDir, 'extension.tar.gz');
  const backupDir = `${EXTENSION_DIR}.old-${process.pid}-${Date.now()}`;

  try {
    // Same filesystem as EXTENSION_DIR so the final rename cannot hit EXDEV.
    stagingDir = fs.mkdtempSync(path.join(SUPERSURF_DIR, '.extension-staging-'));
    await downloadFile(tarballUrl, tarballPath);
    debugLog('Tarball downloaded, extracting...');

    // Whole archive, no member pattern: GNU tar does not glob members without --wildcards.
    execFileSync('tar', ['xzf', tarballPath, '-C', stagingDir], { stdio: 'pipe' });

    const tops = fs.readdirSync(stagingDir);
    const invalid = () => new Error('Extension tarball has no valid extension/manifest.json');
    if (tops.length !== 1) throw invalid();
    const staged = path.join(stagingDir, tops[0], 'extension');
    let valid = false;
    try {
      const st = fs.lstatSync(staged);
      if (!st.isDirectory() || st.isSymbolicLink()) throw invalid();
      const manifest = JSON.parse(fs.readFileSync(path.join(staged, 'manifest.json'), 'utf8'));
      valid = typeof manifest.version === 'string';
    } catch {}
    if (!valid) throw invalid();

    const hadOld = fs.existsSync(EXTENSION_DIR);
    if (hadOld) fs.renameSync(EXTENSION_DIR, backupDir);
    try {
      fs.renameSync(staged, EXTENSION_DIR);
    } catch (err) {
      if (hadOld) fs.renameSync(backupDir, EXTENSION_DIR);
      throw err;
    }
    try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}

    debugLog('Extension extracted to', EXTENSION_DIR);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    if (stagingDir) try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Ensure the extension is cached locally and up to date.
 *
 * - Not cached: pull from GitHub (required for first-time setup)
 * - Cached: check GitHub for newer version (non-blocking — if network
 *   fails, the cached version is used)
 */
export async function ensureExtension(): Promise<void> {
  // A dev clone serves the extension straight from its checkout — no download.
  if (devSource('extension')) return;

  if (!isExtensionCached()) {
    debugLog('Extension not cached, pulling from GitHub...');
    await pullExtension();
    return;
  }

  // Already cached — update check is best-effort
  const cachedVersion = getCachedVersion();
  try {
    const latestTag = await getLatestTag();
    const latestVersion = latestTag.replace(/^v/, '');

    if (cachedVersion !== latestVersion) {
      debugLog(`Extension update available (cached: ${cachedVersion}, latest: ${latestVersion}), pulling...`);
      await pullExtension(latestTag);
    } else {
      debugLog(`Extension up to date (v${cachedVersion})`);
    }
  } catch (err: any) {
    debugLog(`GitHub update check failed (using cached v${cachedVersion}): ${err.message}`);
  }
}
