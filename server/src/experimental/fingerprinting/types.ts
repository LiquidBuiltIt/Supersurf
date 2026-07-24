// Multi-signal fingerprint of a resolved element (v3-validated signal set).
export interface Fingerprint {
  role: string;
  name: string;          // accessible name, descends into children (icon/img/nested)
  text: string;          // direct text
  tag: string;
  type: string | null;
  attrs: Record<string, string>;
  classList: string[];
  htmlId: string;
  ordinal: number;       // index among same-role candidates
  cx: number;            // viewport-center x at capture
  cy: number;
  neighborText: string;  // text of spatial neighbors (~140px)
  landmark: string;      // nearest ancestor landmark role + name
}

export interface FingerprintRecord extends Fingerprint {
  selector: string;      // the selector that resolved to this element (lookup key)
  capturedAt: number;    // epoch ms, first capture
  lastSeenAt: number;    // epoch ms, last successful (re)capture
  hits: number;          // times this selector resolved cleanly
  // ── Playbooks write-side (optional; only populated when the agent supplies a name) ──
  // NOTE: named `handleName`, not `name` — Fingerprint.name is the accessible name used for
  // match scoring (see page-scripts.ts); reusing `name` here would collide with it (both in the
  // TS type-check, since it's required there, and at runtime by overwriting that signal).
  handleName?: string;   // canonical handle name (snake_case), first-seen wins
  purpose?: string;      // latest agent-supplied intent, trimmed
  aliases?: Record<string, number>; // other names this element was labeled with -> frequency
}

export interface DomainStore {
  domain: string;
  routes: Record<string, Record<string, FingerprintRecord>>; // route -> selector -> record
}

// Best in-page candidate match returned by the scorer (pre-threshold).
export interface ScoreHit {
  cx: number;
  cy: number;
  score: number;
  margin: number;
}
