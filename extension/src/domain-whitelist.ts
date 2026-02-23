/**
 * DomainWhitelist — restricts automated navigation to Tranco top 100K domains.
 * Disabled by default. Extension-only enforcement via chrome.webNavigation.
 *
 * Design choices:
 * - Passthrough when disabled OR when list hasn't loaded (never block everything)
 * - Root domain matching: subdomains pass if root is whitelisted
 * - ZIP fetched from Tranco, parsed in-browser via DecompressionStream (zero deps)
 * - Cache in chrome.storage.local, refreshed every 24h via alarm
 */

const TRANCO_URL = 'https://tranco-list.eu/top-1m.csv.zip';
const MAX_DOMAINS = 100_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const STORAGE_KEY_ENABLED = 'domainWhitelistEnabled';
const STORAGE_KEY_DATA = 'domainWhitelistData';
const STORAGE_KEY_LAST_FETCH = 'domainWhitelistLastFetch';

const SPECIAL_SCHEMES = ['about:', 'chrome:', 'chrome-extension:', 'data:', 'blob:', 'javascript:'];

/**
 * Restricts automated navigation to the Tranco top 100K domains.
 *
 * Safety-first design: when disabled, when the domain list is empty, or when a URL
 * uses a special scheme (about:, chrome:, data:, etc.), navigation is always allowed.
 * This prevents the whitelist from ever locking the user out of the browser.
 *
 * Domain matching uses a suffix-walk algorithm: for a hostname like `mail.google.com`,
 * it checks `mail.google.com`, then `google.com`, then `com` against the Set.
 * This means whitelisting `google.com` automatically allows all subdomains.
 *
 * @example
 * const wl = new DomainWhitelist();
 * await wl.init();    // loads cached state from chrome.storage.local
 * await wl.enable();  // fetches Tranco list if cache is stale
 * wl.isDomainAllowed('https://docs.google.com/spreadsheets'); // true
 */
export class DomainWhitelist {
  private _domains: Set<string> = new Set();
  private _enabled = false;
  private _lastFetch = 0;

  /**
   * Load enabled state + cached data from storage. No network.
   * Called on every service worker wake.
   */
  async init(): Promise<void> {
    const result = await chrome.storage.local.get([
      STORAGE_KEY_ENABLED,
      STORAGE_KEY_DATA,
      STORAGE_KEY_LAST_FETCH,
    ]);

    this._enabled = result[STORAGE_KEY_ENABLED] === true;
    this._lastFetch = result[STORAGE_KEY_LAST_FETCH] || 0;

    if (this._enabled && Array.isArray(result[STORAGE_KEY_DATA])) {
      this._domains = new Set(result[STORAGE_KEY_DATA]);
    }
  }

  /**
   * Enable whitelist. Uses cache if fresh (<24h), otherwise fetches Tranco.
   */
  async enable(): Promise<void> {
    this._enabled = true;
    await chrome.storage.local.set({ [STORAGE_KEY_ENABLED]: true });

    if (this._domains.size > 0 && this._isCacheFresh()) {
      return; // cache is good
    }

    // Try loading from storage cache first
    const result = await chrome.storage.local.get([STORAGE_KEY_DATA, STORAGE_KEY_LAST_FETCH]);
    const cachedFetch = result[STORAGE_KEY_LAST_FETCH] || 0;

    if (Array.isArray(result[STORAGE_KEY_DATA]) && result[STORAGE_KEY_DATA].length > 0 &&
        Date.now() - cachedFetch < CACHE_TTL_MS) {
      this._domains = new Set(result[STORAGE_KEY_DATA]);
      this._lastFetch = cachedFetch;
      return;
    }

    // Fetch fresh
    await this.refreshList();
  }

  /**
   * Disable whitelist. Clears in-memory Set but keeps cache for instant re-enable.
   */
  async disable(): Promise<void> {
    this._enabled = false;
    this._domains.clear();
    await chrome.storage.local.set({ [STORAGE_KEY_ENABLED]: false });
  }

  /**
   * Check if a URL's domain is allowed.
   * Returns true if: disabled, Set empty, special scheme, or domain matches.
   */
  isDomainAllowed(url: string): boolean {
    if (!this._enabled) return true;
    if (this._domains.size === 0) return true;

    // Allow special schemes
    for (const scheme of SPECIAL_SCHEMES) {
      if (url.startsWith(scheme)) return true;
    }

    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return true; // malformed URL — don't block
    }

    if (!hostname) return true;

    // Suffix-walk: mail.google.com -> google.com -> com
    // Stops at length-1 to skip bare TLDs (e.g., "com" alone is never matched)
    const parts = hostname.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      const suffix = parts.slice(i).join('.');
      if (this._domains.has(suffix)) return true;
    }

    return false;
  }

  /**
   * Fetch Tranco list, update cache + Set.
   * On failure, keeps old cached data.
   */
  async refreshList(): Promise<void> {
    try {
      const domains = await this._fetchTrancoList();
      if (domains.length === 0) return; // don't replace good data with nothing

      this._domains = new Set(domains);
      this._lastFetch = Date.now();

      await chrome.storage.local.set({
        [STORAGE_KEY_DATA]: domains,
        [STORAGE_KEY_LAST_FETCH]: this._lastFetch,
      });
    } catch {
      // Failed fetch — keep existing data, passthrough if empty
    }
  }

  /** Stats for popup/debugging. */
  getStats(): { enabled: boolean; domainCount: number; lastFetch: number } {
    return {
      enabled: this._enabled,
      domainCount: this._domains.size,
      lastFetch: this._lastFetch,
    };
  }

  get enabled(): boolean {
    return this._enabled;
  }

  private _isCacheFresh(): boolean {
    return Date.now() - this._lastFetch < CACHE_TTL_MS;
  }

  /**
   * Fetch and parse Tranco top-1M ZIP → extract first 100K domains.
   * ZIP handling: parse local file header with DataView, decompress via DecompressionStream.
   */
  private async _fetchTrancoList(): Promise<string[]> {
    const response = await fetch(TRANCO_URL);
    if (!response.ok) throw new Error(`Tranco fetch failed: ${response.status}`);

    const buffer = await response.arrayBuffer();
    const csv = await this._extractZip(buffer);
    return this._parseCsv(csv);
  }

  /**
   * Extract first file from ZIP using DataView + DecompressionStream.
   * Only reads the first local file header -- sufficient since Tranco ZIPs contain a single CSV.
   *
   * ZIP local file header layout (all little-endian):
   *   Offset 0:  signature (4 bytes) = 0x04034b50
   *   Offset 8:  compression method (2 bytes) — 0=stored, 8=deflate
   *   Offset 18: compressed size (4 bytes)
   *   Offset 26: filename length (2 bytes)
   *   Offset 28: extra field length (2 bytes)
   *   Offset 30: filename (variable) + extra field (variable) + compressed data
   */
  private async _extractZip(buffer: ArrayBuffer): Promise<string> {
    const view = new DataView(buffer);

    const signature = view.getUint32(0, true);
    if (signature !== 0x04034b50) throw new Error('Invalid ZIP file');

    const compressionMethod = view.getUint16(8, true);
    const compressedSize = view.getUint32(18, true);
    const filenameLen = view.getUint16(26, true);
    const extraLen = view.getUint16(28, true);

    const dataOffset = 30 + filenameLen + extraLen;
    const compressedData = new Uint8Array(buffer, dataOffset, compressedSize);

    if (compressionMethod === 0) {
      // Stored (no compression)
      return new TextDecoder().decode(compressedData);
    }

    // Deflate (method 8) — use DecompressionStream with deflate-raw
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();

    writer.write(compressedData);
    writer.close();

    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return new TextDecoder().decode(result);
  }

  /** Parse CSV: "rank,domain\n1,google.com\n..." → first 100K domains. */
  private _parseCsv(csv: string): string[] {
    const lines = csv.split('\n');
    const domains: string[] = [];

    for (let i = 0; i < lines.length && domains.length < MAX_DOMAINS; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const comma = line.indexOf(',');
      if (comma === -1) continue;
      const domain = line.substring(comma + 1).trim();
      if (domain && domain.includes('.')) {
        domains.push(domain);
      }
    }

    return domains;
  }
}
