import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { DomainStore, FingerprintRecord } from './types';

let baseDir = path.join(os.homedir(), '.supersurf', 'fingerprints');

/**
 * Parsed-domain memo, keyed by absolute file path.
 *
 * Guarded by mtime AND size rather than write-through invalidation: each MCP client
 * runs its own server process and several can target the same domain file, so a
 * write-through-only cache would serve another process's stale parse indefinitely.
 * `statSync` is one syscall with no parse; `size` covers the case where two writes
 * land inside the same filesystem mtime granularity.
 */
const cache = new Map<string, { mtimeMs: number; size: number; data: DomainStore }>();

/** Test-only override of the storage directory. Clears the memo. */
export function setBaseDirForTests(dir: string): void {
  baseDir = dir;
  cache.clear();
}

function domainFile(domain: string): string {
  // domain is a hostname; safe as a filename. Strip anything odd defensively.
  const safe = domain.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(baseDir, `${safe}.json`);
}

/**
 * Read a domain store, reusing the last parse when the file on disk is unchanged.
 *
 * CONTRACT: the returned object is the cached instance, not a copy. Treat it as
 * read-only — mutate a store only via `putRecord`, which saves and refreshes the
 * memo in the same breath. Mutating without saving poisons the cache.
 */
export function loadDomain(domain: string): DomainStore {
  const file = domainFile(domain);
  try {
    const st = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as DomainStore;
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
    return data;
  } catch {
    // Missing or unparseable: drop any memo so a later valid write is picked up.
    cache.delete(file);
    return { domain, routes: {} };
  }
}

export function saveDomain(store: DomainStore): void {
  fs.mkdirSync(baseDir, { recursive: true });
  const file = domainFile(store.domain);
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
  try {
    const st = fs.statSync(file);
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data: store });
  } catch {
    cache.delete(file);
  }
}

/** Returns the live cached record (same read-only contract as `loadDomain`) — mutate
 *  only via `putRecord`, never in place, or the in-process memo goes stale. */
export function getRecord(domain: string, route: string, selector: string): FingerprintRecord | undefined {
  const store = loadDomain(domain);
  const byRoute = store.routes[route];
  return byRoute ? byRoute[selector] : undefined;
}

export function putRecord(domain: string, route: string, selector: string, rec: FingerprintRecord): void {
  const store = loadDomain(domain);
  if (!store.routes[route]) store.routes[route] = {};
  store.routes[route][selector] = rec;
  saveDomain(store);
}
