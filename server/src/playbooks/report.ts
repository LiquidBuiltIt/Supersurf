/**
 * Playbook read-only reports — list, inspect, validate.
 *
 * Deliberately dependency-light. This module exists so the compiled `supersurf`
 * binary can run `playbook ls|inspect|validate` without pulling `tools/playbooks.ts`,
 * whose top-level imports of `../playbooks/runner` and `../experimental/index` drag
 * in the ConnectionManager stack and, through the screenshot tool, the `sharp`
 * native addon. Nothing in this file's import closure reaches a native addon.
 *
 * Its import closure is exactly: node builtins, ./paths, ./registry, ./runs,
 * ../security/validate (type-only) -> analyzer/meta/rules -> acorn + acorn-walk.
 *
 * @module playbooks/report
 */
import { normalizeName } from './paths';
import { getRecords, getRecord } from './registry';
import { readRunRecords, formatRunSummary } from './runs';
import type { ValidationRecord } from '../security/validate';

function text(body: string, isError = false): any {
  return { content: [{ type: 'text', text: body }], isError };
}

/** Normalized host of a `meta.startingPoint`, or null. */
function startPoint(rec: ValidationRecord): string | null {
  const raw = rec.meta?.startingPoint;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return raw.trim().toLowerCase().replace(/^www\./, '');
}

/**
 * `list`, `inspect` and `validate` are registry reads — no browser, no
 * extension — so `backend.ts` calls them directly to bypass the passive gate.
 */
export function doList(args: any): any {
  const filterRaw = typeof args.domain === 'string' ? args.domain.trim() : '';
  const filter = filterRaw ? filterRaw.toLowerCase().replace(/^www\./, '') : null;

  const rows = getRecords().filter(r => !filter || startPoint(r) === filter);

  if (rows.length === 0) {
    return text(filter ? `No playbooks match domain \`${filter}\`.` : '(no playbooks in ~/.supersurf/playbooks/)');
  }

  const lines = rows.map(r => {
    if (!r.valid) return `${r.name} — ⚠ invalid: ${r.error ?? 'unknown validation error'}`;
    const parts = [`${r.signature} — ${r.meta?.description ?? ''}`];
    const sp = startPoint(r);
    if (sp) parts.push(`start: ${sp}`);
    if (r.meta?.profile) parts.push(`profile: ${r.meta.profile}`);
    if (r.meta?.permissions?.length) parts.push(`permissions: ${r.meta.permissions.join(', ')}`);
    parts.push(formatRunSummary(readRunRecords(r.name, 20)));
    return parts.join('  |  ');
  });
  return text(lines.join('\n'));
}

export function doInspect(args: any): any {
  const name = normalizeName(String(args.name ?? ''));
  if (!name) return text('`name` is required.', true);

  const rec = getRecord(name);
  if (!rec) return text(`No playbook named \`${name}\`. List them with: playbooks {action:"list"}`, true);

  const lines: string[] = [`${name} — ${rec.file}`];
  if (!rec.valid) {
    lines.push(`⚠ invalid: ${rec.error ?? 'unknown validation error'}`);
    return text(lines.join('\n'), true);
  }

  lines.push(rec.signature);
  lines.push(rec.meta?.description ?? '');
  const sp = startPoint(rec);
  if (sp) lines.push(`start: ${sp}`);
  if (rec.meta?.profile) lines.push(`profile: ${rec.meta.profile} (default — override with the \`profile\` arg)`);
  if (rec.meta?.permissions?.length) lines.push(`permissions: ${rec.meta.permissions.join(', ')}`);

  const spec = rec.meta?.params ?? {};
  const keys = Object.keys(spec);
  if (keys.length > 0) {
    lines.push('');
    lines.push('params:');
    for (const k of keys) {
      const d = spec[k];
      lines.push(`  ${k}: ${d.type}${d.required ? ' (required)' : ''}${d.description ? ` — ${d.description}` : ''}`);
    }
  }

  const runs = readRunRecords(name, 5);
  lines.push('');
  lines.push(`runs: ${formatRunSummary(runs)}`);
  for (const r of runs) {
    const mark = r.ok ? '✓' : '✗';
    lines.push(`  ${mark} ${new Date(r.ts).toISOString()}  ${r.durationMs}ms  ${r.caller}${r.ok ? '' : `  ${r.error ?? ''}`}`);
  }
  return text(lines.join('\n'));
}

export function doValidate(args: any): any {
  const name = typeof args.name === 'string' && args.name.trim() ? normalizeName(args.name) : null;

  if (name) {
    const rec = getRecord(name);
    if (!rec) return text(`No playbook named \`${name}\`. List them with: playbooks {action:"list"}`, true);
    return rec.valid
      ? text(`✓ ${rec.name} — ${rec.signature}`)
      : text(`✗ ${rec.name} — ${rec.error ?? 'unknown validation error'}`, true);
  }

  const all = getRecords();
  if (all.length === 0) return text('(no playbooks in ~/.supersurf/playbooks/)');
  const lines = all.map(r => (r.valid ? `✓ ${r.name} — ${r.signature}` : `✗ ${r.name} — ${r.error ?? 'unknown validation error'}`));
  const bad = all.filter(r => !r.valid).length;
  return text(lines.join('\n'), bad > 0);
}
