/**
 * Secure credential fill — character-by-character input with random delays
 * Injected into page context to fill sensitive fields without exposing values to the agent.
 *
 * This is called by the background script when the server sends a secure_fill command.
 * The value comes from server-side env vars — the agent never sees it.
 */
/**
 * Fill a form field with a credential value, typing character-by-character with
 * randomized delays (40-120ms per keystroke) to mimic human input cadence.
 *
 * Dispatches the full keyboard event sequence (keydown -> input -> keyup) for each
 * character, which satisfies input validation in frameworks that listen for individual
 * key events (React controlled inputs, Angular reactive forms, etc.).
 *
 * @param selector - CSS selector targeting the input element (e.g., '#password', 'input[name="pass"]')
 * @param value - The credential value to type. Comes from a server-side env var -- never seen by the agent.
 * @returns Success/error result object
 */
export async function secureFill(selector, value) {
    try {
        const el = document.querySelector(selector);
        if (!el) {
            return { success: false, error: `Element not found: ${selector}` };
        }
        // Focus the element
        el.focus();
        el.dispatchEvent(new Event('focus', { bubbles: true }));
        // Clear existing value
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        // Type character by character with random delays (40-120ms)
        for (const char of value) {
            const delay = 40 + Math.random() * 80;
            await new Promise((r) => setTimeout(r, delay));
            // Dispatch keydown
            el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
            // Update value
            el.value += char;
            // Dispatch input
            el.dispatchEvent(new Event('input', { bubbles: true }));
            // Dispatch keyup
            el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
        }
        // Dispatch change event
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true };
    }
    catch (e) {
        return { success: false, error: e.message };
    }
}
