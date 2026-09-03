"use strict";
/**
 * Content script — tech stack detection + console message relay.
 *
 * Injected at `document_start` on all pages (configured in manifest.json).
 * Runs in an isolated world -- invisible to page JavaScript, which is a key
 * anti-detection property (page-injected scripts show as VM instances in
 * memory profiling; content scripts do not).
 *
 * Two responsibilities:
 * 1. Relay console messages from the injected console-capture script (via window.postMessage)
 *    back to the background service worker (via chrome.runtime.sendMessage).
 * 2. Detect 40+ frontend frameworks, libraries, CSS frameworks, and dev tools by probing
 *    window globals, DOM selectors, and stylesheet hrefs. Results are sent to background.ts
 *    for the `techStack` tab metadata.
 *
 * Adapted from Blueprint MCP (Apache 2.0) -- stripped of OAuth token watching.
 */
// Relay console messages captured by the injected MAIN-world script.
// The injected script posts { __supersurfConsole: { level, text, timestamp } }
// to window; we forward it to the service worker via chrome.runtime.sendMessage.
window.addEventListener('message', (event) => {
    if (event.source !== window)
        return;
    if (event.data?.__supersurfConsole) {
        const message = event.data.__supersurfConsole;
        chrome.runtime.sendMessage({
            type: 'console',
            level: message.level,
            text: message.text,
            timestamp: message.timestamp,
        });
    }
    // Profile registration from daemon's registration page. Everything about the
    // relay (retry budget, reply origin, ack decision) lives in the handler
    // module so it is testable without a browser; this stays a thin delegation.
    handleProfileRegisterRelay(event, {
        runtime: chrome.runtime,
        postMessage: (data, targetOrigin) => window.postMessage(data, targetOrigin),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
    });
});
/**
 * Retry budget. On a fresh install the MV3 service worker may still be spinning
 * up, so a first send can fail outright. Attempt 1 fires immediately and each
 * retry is a further RELAY_RETRY_MS later, so the last attempt starts at
 * (RELAY_MAX_ATTEMPTS - 1) * RELAY_RETRY_MS = 12 s. That has to stay under the
 * registration page's 15 s timeout, otherwise the relay gives up early and the
 * page sits there blaming the extension for seconds after we stopped trying.
 * Fixed interval, not backoff -- a slow worker start is worth re-probing often.
 */
const RELAY_MAX_ATTEMPTS = 25;
const RELAY_RETRY_MS = 500;
/**
 * Handle a `register-profile` page message.
 *
 * The daemon's registration page posts `register-profile` to its own window.
 * This forwards it to the service worker and, only once the worker confirms the
 * storage write, posts `register-profile-ack` back so the page can clear its
 * 15 s failure timeout.
 *
 * Deliberately lives in this file rather than its own module: MV3 content
 * scripts are classic scripts, so a single `import` here makes Chrome refuse to
 * parse the whole file and silently kills console capture and tech-stack
 * detection along with registration. A classic script cannot export either, so
 * this is covered by `npm run smoke.register` -- a real headless Chromium doing
 * the whole round trip -- rather than by a stubbed unit test. That is deliberate:
 * the stubbed test this replaced passed while the feature was completely dead in
 * a browser. `extension/build.ts` fails the build if a module statement ever
 * reappears in the compiled output.
 *
 * @returns `true` when the event was a registration request and the relay took
 *          it, `false` when the event was not ours.
 */
function handleProfileRegisterRelay(event, deps) {
    const data = event?.data;
    if (!data || data.__supersurf !== true || data.action !== 'register-profile' || !data.profile) {
        return false;
    }
    const profile = data.profile;
    // Reply only to the page that asked. '*' would leak the ack to any
    // main-world script listening on this window.
    const replyOrigin = event.origin ?? '';
    const msg = { type: 'profileRegister', profile };
    let attempts = 0;
    const ack = () => {
        // The registration page waits on this and shows a failure state without
        // it. Only sent once the storage write actually completed -- "registered"
        // has to mean the binding is on disk, not that a message was accepted.
        try {
            deps.postMessage({ __supersurf: true, action: 'register-profile-ack', profile }, replyOrigin);
        }
        catch {
            // A page with an opaque origin cannot be replied to; nothing to do.
        }
    };
    const retry = () => {
        if (++attempts < RELAY_MAX_ATTEMPTS)
            deps.setTimeout(trySend, RELAY_RETRY_MS);
    };
    const trySend = () => {
        try {
            deps.runtime.sendMessage(msg, (res) => {
                // No listener / service worker asleep -- Chrome closes the port and
                // sets lastError. Retry; the worker may still be spinning up.
                if (deps.runtime.lastError) {
                    retry();
                    return;
                }
                // A negative reply means the write failed. Do NOT ack -- the page's
                // failure state is exactly the right outcome there.
                if (res?.ok)
                    ack();
            });
        }
        catch {
            retry();
        }
    };
    trySend();
    return true;
}
/**
 * Detect frontend tech stack by probing window globals, DOM structure, and stylesheets.
 *
 * Detection strategy per category:
 * - Frameworks: Check for well-known globals (__REACT_DEVTOOLS_GLOBAL_HOOK__, Vue, ng, etc.)
 *   and fallback to DOM markers (root element IDs, Angular directives).
 * - Libraries: Check globals (jQuery/$, _, d3, Alpine, htmx).
 * - CSS: Match stylesheet hrefs and characteristic CSS class names.
 * - Obfuscated CSS: Sample first 50 elements with classes; if >30% match the pattern
 *   of short-prefix + hash (e.g., "ab_x9f2k"), flag as obfuscated (CSS Modules, Styled Components).
 * - Dev tools: Check for bundler globals (__webpack_require__) and ES module script tags.
 *
 * @returns Object with arrays of detected frameworks, libraries, css frameworks, devTools,
 *          plus boolean flags for spa, autoReload, and obfuscatedCSS.
 */
function detectTechStack() {
    const stack = {
        frameworks: [],
        libraries: [],
        css: [],
        devTools: [],
        spa: false,
        autoReload: false,
        obfuscatedCSS: false,
    };
    try {
        // JS Frameworks
        if (window.React ||
            window.__REACT_DEVTOOLS_GLOBAL_HOOK__ ||
            document.getElementById('root') ||
            document.getElementById('react-root')) {
            stack.frameworks.push('React');
            stack.spa = true;
        }
        if (window.Vue || window.__VUE__ || window.__VUE_DEVTOOLS_GLOBAL_HOOK__) {
            stack.frameworks.push('Vue');
            stack.spa = true;
        }
        if (window.ng || document.querySelector('[ng-app]') || document.querySelector('[ng-controller]')) {
            stack.frameworks.push('Angular');
            stack.spa = true;
        }
        if (window.__SVELTE_HMR) {
            stack.frameworks.push('Svelte');
            stack.spa = true;
        }
        if (window.__NEXT_DATA__) {
            stack.frameworks.push('Next.js');
        }
        if (window.__NUXT__) {
            stack.frameworks.push('Nuxt');
        }
        // Libraries
        if (window.jQuery || window.$?.fn?.jquery) {
            stack.libraries.push('jQuery');
        }
        if (window._ && window._.VERSION) {
            stack.libraries.push('Lodash');
        }
        if (window.d3) {
            stack.libraries.push('D3.js');
        }
        if (window.Alpine) {
            stack.libraries.push('Alpine.js');
        }
        if (window.htmx) {
            stack.libraries.push('HTMX');
        }
        // CSS Frameworks
        const styleSheets = Array.from(document.styleSheets);
        const allCSS = styleSheets
            .map((s) => {
            try {
                return s.href || '';
            }
            catch {
                return '';
            }
        })
            .join(' ');
        if (allCSS.includes('bootstrap') || document.querySelector('.container-fluid, .btn-primary')) {
            stack.css.push('Bootstrap');
        }
        if (allCSS.includes('tailwind') || document.querySelector('[class*="flex "], [class*="grid "]')) {
            stack.css.push('Tailwind');
        }
        if (allCSS.includes('bulma') || document.querySelector('.hero.is-primary')) {
            stack.css.push('Bulma');
        }
        // Obfuscated CSS detection
        const elements = document.querySelectorAll('[class]');
        let obfuscatedCount = 0;
        const sample = Math.min(elements.length, 50);
        for (let i = 0; i < sample; i++) {
            const cls = elements[i].className;
            if (typeof cls === 'string' && /^[a-zA-Z]{1,3}[_-][a-zA-Z0-9]{4,8}$/.test(cls.split(' ')[0])) {
                obfuscatedCount++;
            }
        }
        if (obfuscatedCount > sample * 0.3) {
            stack.obfuscatedCSS = true;
        }
        // Dev tools
        if (window.__webpack_require__)
            stack.devTools.push('Webpack');
        if (document.querySelector('script[type="module"]'))
            stack.devTools.push('ES Modules');
    }
    catch {
        // Ignore errors in detection
    }
    return stack;
}
// Run tech stack detection after page loads.
// Uses a 1s delay to let SPAs hydrate and expose their globals.
// Handles both pre-DOMContentLoaded (readyState === 'loading') and
// already-loaded pages (e.g., when the content script runs late).
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => {
            const techStack = detectTechStack();
            chrome.runtime.sendMessage({ type: 'techStack', data: techStack });
        }, 1000);
    });
}
else {
    setTimeout(() => {
        const techStack = detectTechStack();
        chrome.runtime.sendMessage({ type: 'techStack', data: techStack });
    }, 1000);
}
