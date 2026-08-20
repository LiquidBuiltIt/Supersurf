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

import type { TrailEntry, Playbook, TrailOutcome } from './types';

const MARK: Record<TrailOutcome, string> = { ok: 'ok', warn: '⚠', error: '✗' };

/** Shorten a URL to host + path for the divider line. */
function routeLabel(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/$/, '') || u.host;
  } catch {
    return url;
  }
}

/**
 * The thing a human recognizes the action by: the agent's handle name when it
 * gave one, else the raw selector, else the action verb's own detail.
 */
function targetLabel(e: TrailEntry): string {
  const p = e.params as Record<string, unknown>;
  const name = typeof p.name === 'string' ? p.name : undefined;
  const selector = typeof p.selector === 'string' ? p.selector : undefined;
  const key = typeof p.key === 'string' ? p.key : undefined;
  const url = typeof p.url === 'string' ? p.url : undefined;
  return name ?? selector ?? key ?? url ?? '';
}

export function formatHistory(entries: TrailEntry[], total: number, offset: number): string {
  if (total === 0) return 'No actions recorded yet in this session.';

  const first = entries[0]?.id;
  const last = entries[entries.length - 1]?.id;
  const header = `actions ${first}-${last} of ${total}` +
    (offset + entries.length < total ? `  (older: offset ${offset + entries.length})` : '');

  const lines: string[] = [header, ''];
  let currentRoute: string | null = null;

  for (const e of entries) {
    const route = routeLabel(e.url);
    if (route && route !== currentRoute) {
      lines.push(`── ${route} ──`);
      currentRoute = route;
    }
    const mark = MARK[e.outcome];
    const target = targetLabel(e);
    const detail = e.outcome === 'error' ? `${mark} ${e.message}` : mark;
    lines.push(`#${e.id} ${e.type.padEnd(10)} ${target.padEnd(28)} ${detail}`.trimEnd());
  }

  return lines.join('\n');
}

export function formatSteps(pb: Playbook): string {
  const lines = [`${pb.name} — ${pb.purpose}`, `${pb.steps.length} steps`, ''];
  pb.steps.forEach((s, i) => {
    const p = s.params as Record<string, unknown>;
    const name = typeof p.name === 'string' ? p.name : undefined;
    const selector = typeof p.selector === 'string' ? p.selector : undefined;
    const target = name ?? selector ?? (typeof p.url === 'string' ? p.url : '');
    lines.push(`${String(i + 1).padStart(2)}. ${s.type.padEnd(10)} ${target}`.trimEnd());
  });
  return lines.join('\n');
}
