export interface WebDriveResult {
  passed: boolean;
  evidence: Record<string, unknown>;
  time_ms: number;
}

export interface WebDriveChallenge {
  challenge_id: string;
  domain: string;
  objective: string;
  timeout_ms: number;
  started_at: number;
  result: WebDriveResult | null;
}

declare global {
  interface Window {
    __webdrive: WebDriveChallenge;
  }
}

export const TIMEOUT_12_HOURS_MS = 12 * 60 * 60 * 1000;
