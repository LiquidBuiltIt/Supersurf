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
/**
 * Download a file from a URL via the browser, optionally moving it to a destination path.
 *
 * The extension handles the actual download (with a 5-minute timeout for large files).
 * If `destination` is provided, the file is moved from Chrome's Downloads folder
 * to the specified path (or appended to a directory).
 *
 * @param args - `{ url: string, filename?: string, destination?: string }`
 */
export declare function onBrowserDownload(ctx: ToolContext, args: any, options: any): Promise<any>;
//# sourceMappingURL=downloads.d.ts.map