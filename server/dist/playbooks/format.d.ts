/**
 * Rendering for the playbooks tool — the history view and the step list.
 *
 * The history view prints EVERY recorded action, reads included. That is the
 * harness posture: report what happened and let the agent decide what matters.
 * The route divider is what keeps it readable — a URL repeated on every row
 * roughly doubles the token cost of a long window for no added information.
 *
 * @module playbooks/format
 */
import type { TrailEntry, Playbook } from './types';
export declare function formatHistory(entries: TrailEntry[], total: number, offset: number): string;
export declare function formatSteps(pb: Playbook): string;
//# sourceMappingURL=format.d.ts.map