/**
 * Managed-profile registration page HTML (served at /register/:name).
 *
 * @module profiles/registration-page
 */
/**
 * The page's inline script, without its `<script>` wrapper.
 *
 * Exported so the tests can execute it against a stub DOM instead of only
 * grepping the rendered HTML for substrings. Its only free identifiers are
 * `window`, `document`, `setTimeout` and `clearTimeout`.
 */
export declare function registrationScript(profileName: string): string;
/**
 * Build the registration page. Posts `register-profile` to the extension and
 * waits for the content script's ack before claiming success; without an ack
 * within 15s it shows a failure state (no response, or the write failed).
 * The tab is left open for the user/agent.
 */
export declare function registrationHtml(profileName: string): string;
//# sourceMappingURL=registration-page.d.ts.map