/**
 * Form filling, drag, and secure fill tool handlers.
 *
 * Implements three tools:
 * - `browser_fill_form`: Batch-set values on multiple form fields
 * - `browser_drag`: Simulate drag-and-drop between two elements via CDP mouse events
 * - `secure_fill`: Fill a field from a server-side env var without exposing the value to the agent
 *
 * Form filling uses native property setters (bypassing framework getters)
 * and dispatches input/change events for React/Vue/Angular compatibility.
 *
 * @module tools/forms
 */
import type { ToolContext } from './types';
/**
 * Set values on multiple form fields at once.
 *
 * Handles input, textarea, select (single and multi), checkbox, and radio
 * elements. Uses native prototype setters to bypass framework-managed
 * value properties, then fires input + change events.
 *
 * @param args - `{ fields: Array<{ selector: string, value: string }> }`
 */
export declare function onFillForm(ctx: ToolContext, args: any, options: any): Promise<any>;
/**
 * Drag one element to another using simulated CDP mouse events.
 * Moves in 10 interpolated steps for realistic drag behavior.
 *
 * @param args - `{ fromSelector: string, toSelector: string }`
 */
export declare function onDrag(ctx: ToolContext, args: any, options: any): Promise<any>;
/**
 * Fill a form field with a credential from a server-side environment variable.
 *
 * The agent only provides the env var name — the actual value is resolved
 * server-side and sent directly to the extension, which types it char-by-char
 * with randomized delays. The credential value never appears in MCP responses.
 *
 * @param args - `{ selector: string, credential_env: string }`
 */
export declare function onSecureFill(ctx: ToolContext, args: any, options: any): Promise<any>;
//# sourceMappingURL=forms.d.ts.map