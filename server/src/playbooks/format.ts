/**
 * Rendering for saved JSON playbooks.
 *
 * The trail renderer moved to `playbooks/trail-format.ts`; what is left here
 * renders the step list of the JSON playbook format.
 *
 * @module playbooks/format
 */

import type { Playbook } from './types';

export function formatSteps(pb: Playbook): string {
  const lines = [`${pb.name} — ${pb.purpose}`, `${pb.steps.length} steps`, ''];
  pb.steps.forEach((s, i) => {
    const p = s.params as Record<string, unknown>;
    const name = typeof p.name === 'string' ? p.name : undefined;
    const selector = typeof p.selector === 'string' ? p.selector : undefined;
    const key = typeof p.key === 'string' ? p.key : undefined;
    const target = name ?? selector ?? key ?? (typeof p.url === 'string' ? p.url : '');
    lines.push(`${String(i + 1).padStart(2)}. ${s.type.padEnd(10)} ${target}`.trimEnd());
  });
  return lines.join('\n');
}

/**
 * Full-detail render for `playbooks {action:"inspect"}` — name, purpose,
 * profile (when set), derived domains, createdAt, and the numbered step
 * list with tool, action type, and URL per step. Deliberately distinct from
 * `formatSteps`: that one shows a single best-guess "target" per step for a
 * terse CLI listing, this one shows the three raw fields inspect promises.
 */
export function formatInspect(pb: Playbook, domains: string[]): string {
  const lines: string[] = [`${pb.name} — ${pb.purpose}`];
  if (pb.profile) lines.push(`profile: ${pb.profile}`);
  lines.push(`domains: ${domains.length > 0 ? domains.join(', ') : '(none)'}`);
  lines.push(`created: ${new Date(pb.createdAt).toISOString()}`);
  lines.push(`${pb.steps.length} steps`, '');
  pb.steps.forEach((s, i) => {
    const url = s.url ?? '';
    lines.push(`${String(i + 1).padStart(2)}. ${s.tool.padEnd(24)} ${s.type.padEnd(14)} ${url}`.trimEnd());
  });
  return lines.join('\n');
}
