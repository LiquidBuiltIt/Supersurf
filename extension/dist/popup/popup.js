/**
 * @module popup/popup
 *
 * Entry point for the SuperSurf extension popup. Manages a simple reactive
 * state object ({@link PopupState}) and re-renders the DOM on every change
 * by swapping innerHTML via template functions from `popup.templates.ts`.
 *
 * Communicates with the background service worker via `runtime.sendMessage`
 * to fetch connection status, toggle the extension, and manage settings.
 * Listens for `statusChanged` messages and `storage.onChanged` events
 * to keep the UI in sync without polling.
 */
import { renderMain, renderSettings } from './popup.templates.js';
const browserAPI = chrome;
/** Mutable singleton state — mutated in place, then `render()` is called. */
const state = {
    enabled: true,
    anyConnected: false,
    currentTabConnected: false,
    stealthMode: null,
    connecting: false,
    showSettings: false,
    debugMode: false,
    port: '5555',
    version: '0.1.0',
    projectName: null,
    domainWhitelistEnabled: false,
};
/** Hydrate state from chrome.storage.local and the extension manifest. */
async function loadState() {
    const result = await browserAPI.storage.local.get([
        'extensionEnabled', 'mcpPort', 'debugMode', 'domainWhitelistEnabled',
    ]);
    state.enabled = result.extensionEnabled !== false;
    state.port = result.mcpPort || '5555';
    state.debugMode = result.debugMode === true;
    state.domainWhitelistEnabled = result.domainWhitelistEnabled === true;
    const manifest = browserAPI.runtime.getManifest();
    state.version = manifest.version;
}
/** Fetch live connection status from the background service worker and re-render. */
async function updateStatus() {
    try {
        const response = await browserAPI.runtime.sendMessage({ type: 'getStatus' });
        if (response) {
            state.anyConnected = response.connected || false;
            state.currentTabConnected = response.currentTabConnected || false;
            state.stealthMode = response.stealthMode ?? null;
            state.projectName = response.projectName || null;
        }
    }
    catch {
        // Background may not be ready
    }
    render();
}
/** Toggle the extension on/off, persist to storage, and notify background. */
async function toggleEnabled() {
    state.enabled = !state.enabled;
    await browserAPI.storage.local.set({ extensionEnabled: state.enabled });
    render();
    browserAPI.runtime.sendMessage({
        type: state.enabled ? 'enableExtension' : 'disableExtension',
    }).catch(() => { });
}
/** Persist settings to storage, notify background of whitelist change, close settings view. */
async function saveSettings() {
    await browserAPI.storage.local.set({
        mcpPort: state.port,
        debugMode: state.debugMode,
        domainWhitelistEnabled: state.domainWhitelistEnabled,
    });
    // Notify background to enable/disable whitelist
    browserAPI.runtime.sendMessage({
        type: state.domainWhitelistEnabled ? 'enableWhitelist' : 'disableWhitelist',
    }).catch(() => { });
    state.showSettings = false;
    render();
}
function cancelSettings() {
    state.showSettings = false;
    render();
}
/** Re-render the popup by replacing root innerHTML and re-attaching event listeners. */
function render() {
    const root = document.getElementById('root');
    if (!root)
        return;
    root.innerHTML = state.showSettings ? renderSettings(state) : renderMain(state);
    attachEventListeners();
}
/** Bind click/input/change handlers to DOM elements created by the current template. */
function attachEventListeners() {
    if (state.showSettings) {
        document.getElementById('saveButton')?.addEventListener('click', saveSettings);
        document.getElementById('cancelButton')?.addEventListener('click', cancelSettings);
        document.getElementById('portInput')?.addEventListener('input', (e) => {
            state.port = e.target.value;
        });
        document.getElementById('debugModeCheckbox')?.addEventListener('change', (e) => {
            state.debugMode = e.target.checked;
        });
        document.getElementById('domainWhitelistCheckbox')?.addEventListener('change', (e) => {
            state.domainWhitelistEnabled = e.target.checked;
        });
    }
    else {
        document.getElementById('toggleButton')?.addEventListener('click', toggleEnabled);
        document.getElementById('settingsButton')?.addEventListener('click', () => {
            state.showSettings = true;
            render();
        });
        document.getElementById('privacyLink')?.addEventListener('click', (e) => {
            e.preventDefault();
            chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/privacy-policy.html') });
        });
    }
}
// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    try {
        await loadState();
        await updateStatus();
        browserAPI.runtime.onMessage.addListener((message) => {
            if (message.type === 'statusChanged')
                updateStatus();
        });
        browserAPI.tabs.onActivated.addListener(() => updateStatus());
        browserAPI.storage.onChanged.addListener((changes, areaName) => {
            if (areaName === 'local') {
                if (changes.extensionEnabled) {
                    state.enabled = changes.extensionEnabled.newValue !== false;
                    render();
                }
                if (changes.domainWhitelistEnabled) {
                    state.domainWhitelistEnabled = changes.domainWhitelistEnabled.newValue === true;
                    render();
                }
            }
        });
    }
    catch (error) {
        const root = document.getElementById('root');
        if (root) {
            root.innerHTML = `<div class="popup-container"><p style="color:red">Error: ${error}</p></div>`;
        }
    }
});
