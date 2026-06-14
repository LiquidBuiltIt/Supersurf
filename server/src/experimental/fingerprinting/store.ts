import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { DomainStore, FingerprintRecord } from './types';

let baseDir = path.join(os.homedir(), '.supersurf', 'fingerprints');

/** Test-only override of the storage directory. */
export function setBaseDirForTests(dir: string): void {
  baseDir = dir;
}

function domainFile(domain: string): string {
  // domain is a hostname; safe as a filename. Strip anything odd defensively.
  const safe = domain.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(baseDir, `${safe}.json`);
}

export function loadDomain(domain: string): DomainStore {
  try {
    return JSON.parse(fs.readFileSync(domainFile(domain), 'utf8')) as DomainStore;
  } catch {
    return { domain, routes: {} };
  }
}

export function saveDomain(store: DomainStore): void {
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(domainFile(store.domain), JSON.stringify(store, null, 2));
}

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
