/**
 * @module popup/popup.templates
 *
 * Pure HTML template functions for the extension popup, separated from
 * state management in `popup.ts`. Each function takes the current
 * {@link PopupState} and returns an HTML string for innerHTML replacement.
 *
 * Key exports:
 * - {@link renderMain} — connection status, stealth indicator, enable/disable toggle
 * - {@link renderSettings} — port config, debug mode, domain whitelist toggles
 * - {@link PopupState} — shared state interface consumed by both modules
 */

/** Shared mutable state driving both the main and settings views. */
export interface PopupState {
  enabled: boolean;
  anyConnected: boolean;
  currentTabConnected: boolean;
  stealthMode: boolean | null;
  connecting: boolean;
  showSettings: boolean;
  debugMode: boolean;
  port: string;
  version: string;
  projectName: string | null;
  domainWhitelistEnabled: boolean;
}

/** Render the main popup view: status indicator, tab info, and enable/disable toggle. */
export function renderMain(state: PopupState): string {
  const statusClass = state.connecting ? 'connecting' : state.anyConnected ? 'connected' : 'disconnected';
  const statusText = state.connecting ? 'Connecting' : state.anyConnected ? 'Connected' : 'Disconnected';

  return `
    <div class="popup-container">
      <div class="popup-header">
        <h1>SuperSurf<span class="version-label">v${state.version}</span></h1>
      </div>

      <div class="popup-content">
        <div class="status-row">
          <span class="status-label">Status:</span>
          <div class="status-indicator">
            <span class="status-dot ${statusClass}"></span>
            <span class="status-text">${statusText}</span>
          </div>
        </div>

        <div class="status-row">
          <span class="status-label">This tab:</span>
          <span class="status-text">${state.currentTabConnected ? '✓ Automated' : 'Not automated'}</span>
        </div>

        ${state.currentTabConnected && state.projectName ? `
          <div class="status-row">
            <span class="status-label"></span>
            <span class="status-text" style="font-size: 0.9em; color: #777">
              ${state.projectName}
            </span>
          </div>
        ` : ''}

        ${state.currentTabConnected ? `
          <div class="status-row">
            <span class="status-label">Stealth:</span>
            <span class="status-text">
              ${state.stealthMode === null ? 'N/A' : state.stealthMode ? 'On' : 'Off'}
            </span>
          </div>
        ` : ''}

        <div class="toggle-row">
          <button
            class="toggle-button ${state.enabled ? 'enabled' : 'disabled'}"
            id="toggleButton"
          >
            ${state.enabled ? 'Disable' : 'Enable'}
          </button>
        </div>

        <div class="links-section">
          <button class="settings-link" id="settingsButton">
            Settings
          </button>
          <a class="doc-link" id="privacyLink" href="#">
            Privacy Policy
          </a>
        </div>
      </div>
    </div>
  `;
}

/** Render the settings view: port input, debug mode checkbox, domain whitelist toggle. */
export function renderSettings(state: PopupState): string {
  return `
    <div class="popup-container">
      <div class="popup-header">
        <h1>SuperSurf<span class="version-label">Settings</span></h1>
      </div>

      <div class="popup-content">
        <div class="settings-form">
          <label class="settings-label">
            MCP Server Port:
            <input
              type="number"
              class="settings-input"
              id="portInput"
              value="${state.port}"
              min="1"
              max="65535"
              placeholder="5555"
            />
          </label>
          <p class="settings-help">
            Default: 5555. Change if your MCP server uses a different port.
          </p>

          <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #2a2a30">
            <label class="settings-label" style="flex-direction: row; align-items: center; cursor: pointer">
              <input
                type="checkbox"
                id="debugModeCheckbox"
                ${state.debugMode ? 'checked' : ''}
                style="width: 16px; height: 16px; margin-right: 8px; cursor: pointer; accent-color: #c0c0c0"
              />
              <span>Debug Mode</span>
            </label>
            <p class="settings-help" style="margin-top: 4px; margin-left: 24px">
              Enable detailed logging for troubleshooting
            </p>
          </div>

          <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #2a2a30">
            <label class="settings-label" style="flex-direction: row; align-items: center; cursor: pointer">
              <input
                type="checkbox"
                id="domainWhitelistCheckbox"
                ${state.domainWhitelistEnabled ? 'checked' : ''}
                style="width: 16px; height: 16px; margin-right: 8px; cursor: pointer; accent-color: #c0c0c0"
              />
              <span>Domain Whitelist</span>
            </label>
            <p class="settings-help" style="margin-top: 4px; margin-left: 24px">
              Restrict automated navigation to Tranco top 100K domains
            </p>
          </div>
        </div>

        <div class="settings-actions">
          <button class="settings-button save" id="saveButton">Save</button>
          <button class="settings-button cancel" id="cancelButton">Cancel</button>
        </div>
      </div>
    </div>
  `;
}
