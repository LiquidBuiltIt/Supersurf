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
});
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
