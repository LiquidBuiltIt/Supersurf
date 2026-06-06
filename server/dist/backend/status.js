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
    const { config, state, debugMode, connectedBrowserName, attachedTab, stealthMode, extensionServer, configDriftWarning } = input;
    const version = config.server.version;
    const driftLine = configDriftWarning
        ? '⚠️ ~/.supersurf/config.json changed since daemon start — config edits will not take effect until restart: `npx supersurf daemon restart`\n\n'
        : '';
    if (state === 'passive') {
        return `${driftLine}🔴 v${version} | Disabled\n---\n\n`;
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
    parts.push(`✅ ${versionStr}`);
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
    return driftLine + parts.join(' | ') + '\n---\n\n';
}
//# sourceMappingURL=status.js.map