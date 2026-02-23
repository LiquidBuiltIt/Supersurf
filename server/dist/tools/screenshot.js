"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.onScreenshot = onScreenshot;
exports.onPdfSave = onPdfSave;
const fs_1 = __importDefault(require("fs"));
const sharp_1 = __importDefault(require("sharp"));
const image_size_1 = __importDefault(require("image-size"));
const logger_1 = require("../logger");
const sandbox_1 = require("./sandbox");
const log = (0, logger_1.createLog)('[Screenshot]');
/** Max pixel dimension for screenshots returned as base64 to the agent. */
const SCREENSHOT_MAX_DIMENSION = 2000;
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
async function onScreenshot(ctx, args, options) {
    const filePath = args.path;
    // Build capture params
    const captureParams = { format: args.type || 'jpeg' };
    if (args.quality)
        captureParams.quality = args.quality;
    if (args.clip_x !== undefined) {
        captureParams.clip = {
            x: args.clip_x, y: args.clip_y,
            width: args.clip_width, height: args.clip_height,
            scale: 1,
        };
    }
    // Highlight clickable elements if requested
    if (args.highlightClickables) {
        await ctx.eval(`
      (() => {
        const clickables = document.querySelectorAll('a, button, input, select, textarea, [onclick], [role="button"]');
        clickables.forEach(el => {
          el.style.outline = '2px solid #00ff00';
          el.style.outlineOffset = '1px';
        });
      })()
    `);
        await ctx.sleep(100);
    }
    const result = await ctx.ext.sendCmd('screenshot', captureParams, 60000);
    // Remove highlights
    if (args.highlightClickables) {
        await ctx.eval(`
      (() => {
        const clickables = document.querySelectorAll('a, button, input, select, textarea, [onclick], [role="button"]');
        clickables.forEach(el => {
          el.style.outline = '';
          el.style.outlineOffset = '';
        });
      })()
    `).catch(() => { });
    }
    if (!result?.data) {
        return ctx.formatResult('browser_take_screenshot', result, options);
    }
    let buffer = Buffer.from(result.data, 'base64');
    const format = args.type || 'jpeg';
    // Save to file (no downscaling — file saves keep original resolution)
    if (filePath) {
        const safePath = (0, sandbox_1.sandboxPath)(filePath);
        fs_1.default.writeFileSync(safePath, buffer);
        if (options.rawResult)
            return { success: true, path: safePath, size: buffer.length };
        return {
            content: [{ type: 'text', text: `Screenshot saved to ${safePath} (${buffer.length} bytes)` }],
        };
    }
    // Auto-downscale for base64 returns to prevent API token blowup
    if (SCREENSHOT_MAX_DIMENSION > 0) {
        try {
            const dims = (0, image_size_1.default)(buffer);
            if (dims.width && dims.height &&
                (dims.width > SCREENSHOT_MAX_DIMENSION || dims.height > SCREENSHOT_MAX_DIMENSION)) {
                const scale = Math.min(SCREENSHOT_MAX_DIMENSION / dims.width, SCREENSHOT_MAX_DIMENSION / dims.height);
                const targetW = Math.round(dims.width * scale);
                const targetH = Math.round(dims.height * scale);
                buffer = Buffer.from(await (0, sharp_1.default)(buffer)
                    .resize(targetW, targetH, { fit: 'fill', kernel: 'lanczos3' })
                    .toFormat(format === 'png' ? 'png' : 'jpeg', {
                    quality: format === 'jpeg' ? (args.quality || 80) : undefined,
                })
                    .toBuffer());
                log(`Screenshot downscaled from ${dims.width}x${dims.height} to ${targetW}x${targetH}`);
            }
        }
        catch (e) {
            log('Screenshot downscale failed, returning original:', e.message);
        }
    }
    const b64 = buffer.toString('base64');
    if (options.rawResult)
        return { data: b64, mimeType: result.mimeType || `image/${format}` };
    return {
        content: [
            { type: 'text', text: 'Screenshot captured' },
            { type: 'image', data: b64, mimeType: result.mimeType || `image/${format}` },
        ],
    };
}
/**
 * Export the current page as a PDF using CDP Page.printToPDF.
 *
 * @param args - `{ path?: string }` — file path for output
 */
async function onPdfSave(ctx, args, options) {
    const filePath = args.path;
    const result = await ctx.cdp('Page.printToPDF', {});
    if (result?.data) {
        const buffer = Buffer.from(result.data, 'base64');
        const safePath = filePath ? (0, sandbox_1.sandboxPath)(filePath) : undefined;
        if (safePath)
            fs_1.default.writeFileSync(safePath, buffer);
        if (options.rawResult)
            return { success: true, path: safePath, size: buffer.length };
        return {
            content: [{ type: 'text', text: `PDF saved to ${safePath} (${buffer.length} bytes)` }],
        };
    }
    return ctx.error('PDF generation failed.\n\n' +
        '**Troubleshooting:**\n' +
        '- Ensure a tab is attached via `browser_tabs action=\'attach\'`\n' +
        '- The page must be fully loaded before generating a PDF', options);
}
//# sourceMappingURL=screenshot.js.map