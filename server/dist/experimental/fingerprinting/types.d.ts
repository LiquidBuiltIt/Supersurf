export interface Fingerprint {
    role: string;
    name: string;
    text: string;
    tag: string;
    type: string | null;
    attrs: Record<string, string>;
    classList: string[];
    htmlId: string;
    ordinal: number;
    cx: number;
    cy: number;
    neighborText: string;
    landmark: string;
}
export interface FingerprintRecord extends Fingerprint {
    selector: string;
    capturedAt: number;
    lastSeenAt: number;
    hits: number;
    handleName?: string;
    purpose?: string;
    aliases?: Record<string, number>;
}
export interface DomainStore {
    domain: string;
    routes: Record<string, Record<string, FingerprintRecord>>;
}
export interface ScoreHit {
    cx: number;
    cy: number;
    score: number;
    margin: number;
}
//# sourceMappingURL=types.d.ts.map