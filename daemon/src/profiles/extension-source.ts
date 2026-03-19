/**
 * Extension source management — downloads and caches the SuperSurf extension
 * from GitHub for use with managed Chromium profiles.
 *
 * @module profiles/extension-source
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import { execSync } from 'child_process';
import type { FileLogger } from 'shared';

const SUPERSURF_DIR = path.join(os.homedir(), '.supersurf');
const EXTENSION_DIR = path.join(SUPERSURF_DIR, 'extension');
const GITHUB_REPO = 'LiquidBuiltIt/Supersurf';

const debugLog = (...args: unknown[]) => {
  const logger = (global as any).DAEMON_LOGGER as FileLogger | undefined;
  if (logger) logger.log('[ExtSrc]', ...args);
  else if ((global as any).DAEMON_DEBUG) console.error('[ExtSrc]', ...args);
};

/** Get the cached extension directory path. */
export function getExtensionDir(): string {
  return EXTENSION_DIR;
}

/** Check if the extension is already cached (manifest.json exists). */
export function isExtensionCached(): boolean {
  return fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'));
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

/** Pull the extension from GitHub tarball and extract to ~/.supersurf/extension/. */
export async function pullExtension(tag?: string): Promise<void> {
  if (!tag) {
    tag = await getLatestTag();
  }
  debugLog(`Pulling extension from tag: ${tag}`);

  const tarballUrl = `https://github.com/${GITHUB_REPO}/archive/refs/tags/${tag}.tar.gz`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supersurf-ext-'));
  const tarballPath = path.join(tmpDir, 'extension.tar.gz');

  try {
    await downloadFile(tarballUrl, tarballPath);
    debugLog('Tarball downloaded, extracting extension/ directory...');

    // Ensure extension directory exists and is clean
    if (fs.existsSync(EXTENSION_DIR)) {
      fs.rmSync(EXTENSION_DIR, { recursive: true });
    }
    fs.mkdirSync(EXTENSION_DIR, { recursive: true });

    // Extract only the extension/ subdirectory, stripping the top-level archive folder
    execSync(
      `tar xzf "${tarballPath}" --strip-components=1 -C "${EXTENSION_DIR}" "*/extension/"`,
      { stdio: 'pipe' },
    );

    // The extraction puts files under EXTENSION_DIR/extension/ — move them up
    const nestedDir = path.join(EXTENSION_DIR, 'extension');
    if (fs.existsSync(nestedDir)) {
      const files = fs.readdirSync(nestedDir);
      for (const f of files) {
        fs.renameSync(path.join(nestedDir, f), path.join(EXTENSION_DIR, f));
      }
      fs.rmdirSync(nestedDir);
    }

    debugLog('Extension extracted to', EXTENSION_DIR);
  } finally {
    // Clean up temp files
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
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

/** Ensure the extension is cached locally and up to date. Pulls from GitHub if missing or stale. */
export async function ensureExtension(): Promise<void> {
  if (!isExtensionCached()) {
    debugLog('Extension not cached, pulling from GitHub...');
    await pullExtension();
    return;
  }

  const latestTag = await getLatestTag();
  const latestVersion = latestTag.replace(/^v/, '');
  const cachedVersion = getCachedVersion();

  if (cachedVersion !== latestVersion) {
    debugLog(`Extension stale (cached: ${cachedVersion}, latest: ${latestVersion}), re-pulling...`);
    await pullExtension(latestTag);
  } else {
    debugLog(`Extension up to date (${cachedVersion}) at`, EXTENSION_DIR);
  }
}
