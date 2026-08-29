"use strict";
/**
 * Status header builder — pure function, no side effects.
 *
 * Generates a compact one-line status string prepended to every MCP tool response.
 * Includes version, browser name, attached tab URL (truncated), tech stack summary,
 * and stealth indicator. In debug mode, also shows the extension build timestamp.
 *
 * @module backend/status
 * @exports buildStatusHeader
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildStatusHeader = buildStatusHeader;
/**
 * Build a pipe-delimited status header from current connection state.
 * Returns a string ending with `\n---\n\n` for markdown separation.
 */
function buildStatusHeader(input) {
    const { config, state, debugMode, connectedBrowserName, attachedTab, stealthMode, extensionServer, extensionConnected, configDriftWarning, lastConnectError, playbookHint, playbookWarning } = input;
    const version = config.server.version;
    const driftLine = configDriftWarning
        ? '⚠️ ~/.supersurf/config.json changed since daemon start — config edits will not take effect until restart: `npx supersurf-daemon@latest restart`\n\n'
        : '';
    if (state === 'passive') {
        const failLine = lastConnectError
            ? `⚠️ Last connect failed: ${lastConnectError}\n\n`
            : '';
        // Warning before hint here too: `playbooks validate` answers in the passive
        // state, so a broken script must be reportable before `connect`.
        const passiveWarn = playbookWarning ? `\n${playbookWarning}` : '';
        const passiveHint = playbookHint ? `\n${playbookHint}` : '';
        return `${driftLine}${failLine}🔴 v${version} | Disabled${passiveWarn}${passiveHint}\n---\n\n`;
    }
    const parts = [];
    let buildTime = null;
    if (extensionServer) {
        buildTime = extensionServer.buildTime;
        if (buildTime) {
            try {
                const date = new Date(buildTime);
                buildTime = date.toLocaleTimeString('en-US', { hour12: false });
            }
            catch {
                // keep original
            }
        }
    }
    const versionStr = buildTime && debugMode ? `v${version} [${buildTime}]` : `v${version}`;
    const noExtension = extensionConnected === false;
    parts.push(`${noExtension ? '⚠️' : '✅'} ${versionStr}`);
    if (noExtension) {
        parts.push(`No extension connected — open the SuperSurf popup, or connect with profile:'<name>' to spawn a managed browser`);
    }
    if (connectedBrowserName) {
        parts.push(`🌐 ${connectedBrowserName}`);
    }
    if (attachedTab) {
        const url = attachedTab.url || 'about:blank';
        const shortUrl = url.length > 50 ? url.substring(0, 47) + '...' : url;
        parts.push(`📄 Tab ${attachedTab.index}: ${shortUrl}`);
        if (attachedTab.techStack) {
            const tech = attachedTab.techStack;
            const techParts = [];
            if (tech.frameworks?.length)
                techParts.push(tech.frameworks.join(', '));
            if (tech.libraries?.length)
                techParts.push(tech.libraries.join(', '));
            if (tech.css?.length)
                techParts.push(tech.css.join(', '));
            if (techParts.length)
                parts.push(`🔧 ${techParts.join(' + ')}`);
            if (tech.obfuscatedCSS)
                parts.push(`⚠️ Obfuscated CSS`);
        }
    }
    else {
        parts.push(`⚠️ No tab attached`);
    }
    if (stealthMode) {
        parts.push(`🕵️ Stealth`);
    }
    const warnLine = playbookWarning ? `\n${playbookWarning}` : '';
    const hintLine = playbookHint ? `\n${playbookHint}` : '';
    return driftLine + parts.join(' | ') + warnLine + hintLine + '\n---\n\n';
}
//# sourceMappingURL=status.js.map