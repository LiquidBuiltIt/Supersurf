/**
 * Download tool handler.
 *
 * Implements `browser_download` — the extension downloads the file to Chrome's
 * Downloads folder, then the server optionally moves it to an agent-specified
 * destination. Handles cross-device moves (EXDEV) by falling back to copy+delete.
 *
 * @module tools/downloads
 */

import type { ToolContext } from './types';
import fs from 'fs';
import path from 'path';
import { createLog } from '../logger';
import { sandboxPath } from './sandbox';

const log = createLog('[Downloads]');

/**
 * Download a file from a URL via the browser, optionally moving it to a destination path.
 *
 * The extension handles the actual download (with a 5-minute timeout for large files).
 * If `destination` is provided, the file is moved from Chrome's Downloads folder
 * to the specified path (or appended to a directory).
 *
 * @param args - `{ url: string, filename?: string, destination?: string }`
 */
export async function onBrowserDownload(ctx: ToolContext, args: any, options: any): Promise<any> {
  const url = args.url as string;
  if (!url) return ctx.error('`url` is required', options);

  const filename = args.filename as string | undefined;
  const destination = args.destination as string | undefined;

  // Send download command to extension
  const result = await ctx.ext.sendCmd('download', { url, filename }, 5 * 60 * 1000);

  if (!result?.success) {
    return ctx.error(result?.error || 'Download failed', options);
  }

  const downloadPath = result.filePath;
  const fileSize = result.fileSize;
  const mimeType = result.mimeType;

  // If no destination specified, return the file where it landed
  if (!destination) {
    if (options.rawResult) {
      return { success: true, path: downloadPath, size: fileSize, mimeType };
    }
    return ctx.formatResult('browser_download', {
      text: `Downloaded to ${downloadPath} (${formatBytes(fileSize)})`,
    }, options);
  }

  // Move file to destination
  if (!downloadPath) {
    return ctx.error('Download completed but file path not available from browser', options);
  }

  try {
    const resolvedDest = resolveDestination(destination, downloadPath);

    // Ensure parent directory exists
    const parentDir = path.dirname(resolvedDest);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    fs.renameSync(downloadPath, resolvedDest);
    log(`Moved ${downloadPath} → ${resolvedDest}`);

    if (options.rawResult) {
      return { success: true, path: resolvedDest, size: fileSize, mimeType };
    }
    return ctx.formatResult('browser_download', {
      text: `Downloaded and saved to ${resolvedDest} (${formatBytes(fileSize)})`,
    }, options);
  } catch (err: any) {
    // If rename fails (cross-device), fall back to copy + delete
    if (err.code === 'EXDEV') {
      try {
        const resolvedDest = resolveDestination(destination, downloadPath);
        const parentDir = path.dirname(resolvedDest);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        fs.copyFileSync(downloadPath, resolvedDest);
        fs.unlinkSync(downloadPath);
        log(`Copied (cross-device) ${downloadPath} → ${resolvedDest}`);

        if (options.rawResult) {
          return { success: true, path: resolvedDest, size: fileSize, mimeType };
        }
        return ctx.formatResult('browser_download', {
          text: `Downloaded and saved to ${resolvedDest} (${formatBytes(fileSize)})`,
        }, options);
      } catch (copyErr: any) {
        return ctx.error(`Download succeeded but failed to move file: ${copyErr.message}`, options);
      }
    }
    return ctx.error(`Download succeeded but failed to move file: ${err.message}`, options);
  }
}

/**
 * Resolve the destination path.
 * If destination is a directory, append the original filename.
 * If destination is a file path, use it directly.
 */
function resolveDestination(destination: string, downloadPath: string): string {
  const resolved = sandboxPath(destination);

  // If destination exists and is a directory, or ends with separator, append filename
  if ((fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) ||
      destination.endsWith('/') || destination.endsWith(path.sep)) {
    return path.join(resolved, path.basename(downloadPath));
  }

  return resolved;
}

/** Format a byte count as a human-readable string (B, KB, or MB). */
function formatBytes(bytes?: number): string {
  if (!bytes) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
