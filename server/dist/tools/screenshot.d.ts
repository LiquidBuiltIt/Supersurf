/**
 * Screenshot and PDF tool handlers.
 *
 * Implements `browser_take_screenshot` and `browser_pdf_save`.
 *
 * Screenshots are captured via the extension's CDP Page.captureScreenshot,
 * then optionally downscaled using Sharp to prevent base64 token blowup
 * when returned inline to the agent. File saves bypass downscaling.
 *
 * Supports: format selection, quality, full-page, element crop via selector,
 * coordinate clipping, device scale, and clickable element highlighting.
 *
 * @module tools/screenshot
 */
import type { ToolContext } from './types';
/**
 * Capture a screenshot of the current page or a specific element/region.
 *
 * When saving to a file path, the original resolution is preserved.
 * When returning as base64 (no path), images wider/taller than
 * {@link SCREENSHOT_MAX_DIMENSION} are downscaled with Lanczos3 to
 * keep MCP response sizes reasonable.
 *
 * @param args - Screenshot options (type, quality, fullPage, path, clip, selector, etc.)
 */
export declare function onScreenshot(ctx: ToolContext, args: any, options: any): Promise<any>;
/**
 * Export the current page as a PDF using CDP Page.printToPDF.
 *
 * @param args - `{ path?: string }` — file path for output
 */
export declare function onPdfSave(ctx: ToolContext, args: any, options: any): Promise<any>;
//# sourceMappingURL=screenshot.d.ts.map