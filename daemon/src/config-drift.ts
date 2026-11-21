import crypto from 'crypto';
import fs from 'fs';

const sha = (b: Buffer | string): string => crypto.createHash('sha256').update(b).digest('hex');
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Hash of the config file the daemon compares against its startup hash. '' when unreadable.
 * `agents.relay` is left out (only the client reads it, and it needs a client restart, not a
 * daemon restart); an unparsable file hashes as raw bytes. Parsed files hash canonical
 * JSON, so whitespace-only edits no longer flag drift.
 */
export function configHash(p: string): string {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(p);
  } catch {
    return '';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return sha(bytes);
  }
  if (isObj(parsed) && isObj(parsed.agents)) {
    delete parsed.agents.relay;
    if (Object.keys(parsed.agents).length === 0) delete parsed.agents;
  }
  return sha(JSON.stringify(parsed));
}
