/**
 * One-shot JSON playbook -> `.playbook.js` converter.
 *
 * This is the LAST code that will ever read the JSON format; the reader is
 * deleted in the same release. It therefore carries its own local copy of the
 * legacy shape rather than importing from `playbooks/types.ts`, whose
 * `Playbook`/`PlaybookStep` are going away.
 *
 * A migrated script has NO params. That is correct, not a gap: a recording is
 * a fixed value, and parameterization is exactly the thing the JSON format
 * could not express. The output is a starting point a human edits.
 *
 * Anything that cannot be mapped is emitted as a `// TODO` line carrying the
 * original step verbatim. Guessing at a step would produce a script that runs
 * and does the wrong thing, which is strictly worse than one that does not
 * compile.
 *
 * @module playbooks/migrate
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getPlaybooksDir, playbookFile, normalizeName } from './paths';

/** The legacy on-disk shape. Copied here because its type module is going away. */
interface LegacyStep {
  tool: string;
  type: string;
  params: Record<string, any>;
  url?: string;
  sourceId: number;
}
interface LegacyPlaybook {
  name: string;
  purpose: string;
  steps: LegacyStep[];
  createdAt: number;
  version: number;
  profile?: string;
}

export interface RunOpts {
  log?: (msg: string) => void;
}

function q(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Render an options object as inline JS, or '' when empty. */
function obj(fields: Record<string, unknown>): string {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? q(v) : JSON.stringify(v)}`);
  return parts.length === 0 ? '' : `{ ${parts.join(', ')} }`;
}

/** Fields the recorder adds for its own bookkeeping; they are not client args. */
const RECORDER_ONLY = new Set(['type', 'name', 'purpose']);

function interactLine(p: Record<string, any>): string | null {
  switch (p.type) {
    case 'click':             return `supersurf.click(${q(p.selector)});`;
    case 'type':              return `supersurf.type(${q(p.selector)}, ${q(String(p.text ?? ''))});`;
    case 'clear':             return `supersurf.clear(${q(p.selector)});`;
    case 'press_key':         return `supersurf.pressKey(${q(p.key)});`;
    case 'hover':             return `supersurf.hover(${q(p.selector)});`;
    case 'wait':              return typeof p.timeout === 'number'
                                ? `supersurf.wait(${p.timeout});`
                                : `supersurf.wait(${q(p.selector)});`;
    case 'mouse_move':        return `supersurf.mouseMove(${p.x}, ${p.y});`;
    case 'mouse_click':       return `supersurf.mouseClick(${p.x}, ${p.y});`;
    case 'scroll_to':         return `supersurf.scrollTo(${q(p.selector)});`;
    case 'scroll_by':         return `supersurf.scrollBy(${p.x ?? 0}, ${p.y ?? 0});`;
    case 'scroll_into_view':  return `supersurf.scrollIntoView(${q(p.selector)});`;
    case 'select_option':     return `supersurf.selectOption(${q(p.selector)}, ${q(String(p.value ?? ''))});`;
    case 'select_custom':     return `supersurf.selectCustom(${q(p.selector)}, ${q(String(p.value ?? ''))});`;
    case 'file_upload':       return `supersurf.upload(${q(p.selector)}, ${JSON.stringify(p.files ?? [])});`;
    case 'force_pseudo_state': return `supersurf.forcePseudoState(${q(p.selector)}, ${JSON.stringify(p.pseudoStates ?? [])});`;
    default: return null;
  }
}

/** One legacy step -> one line of script. `manual` marks a step a human must finish. */
export function stepToSource(step: LegacyStep): { line: string; manual: boolean } {
  const p = step.params ?? {};

  if (step.tool === 'browser_interact') {
    const call = interactLine(p);
    if (call) return { line: `  await ${call}`, manual: false };
  }

  if (step.tool === 'browser_navigate') {
    if (p.action === 'url' && typeof p.url === 'string') return { line: `  await supersurf.goto(${q(p.url)});`, manual: false };
    if (p.action === 'back') return { line: '  await supersurf.back();', manual: false };
    if (p.action === 'forward') return { line: '  await supersurf.forward();', manual: false };
    if (p.action === 'reload') return { line: '  await supersurf.reload();', manual: false };
  }

  const rest = Object.fromEntries(Object.entries(p).filter(([k]) => !RECORDER_ONLY.has(k)));

  switch (step.tool) {
    case 'browser_snapshot':
      return { line: `  await supersurf.snapshot(${obj(rest)});`, manual: false };
    case 'browser_lookup':
      return { line: `  await supersurf.lookup(${q(String(rest.text ?? ''))});`, manual: false };
    case 'browser_extract_content':
      return { line: `  await supersurf.extract(${obj(rest)});`, manual: false };
    case 'browser_get_element_styles':
      return { line: `  await supersurf.styles(${q(String(rest.selector ?? ''))}, ${obj(rest)});`, manual: false };
    case 'browser_take_screenshot':
      return { line: `  await supersurf.screenshot(${obj(rest)});`, manual: false };
    case 'browser_verify_text_visible':
      return { line: `  await supersurf.seeText(${q(String(rest.text ?? ''))});`, manual: false };
    case 'browser_verify_element_visible':
      return { line: `  await supersurf.seeElement(${q(String(rest.selector ?? ''))});`, manual: false };
    case 'browser_fill_form':
      return { line: `  await supersurf.fill(${JSON.stringify(rest.fields ?? {})});`, manual: false };
    case 'browser_network_requests':
      return { line: `  await supersurf.net.requests(${obj(rest)});`, manual: false };
    case 'browser_console_messages':
      return { line: `  await supersurf.net.console(${obj(rest)});`, manual: false };
    case 'browser_storage':
      // The legacy `action` enum and the client's `storage.*` method names are
      // the same five words (get/set/delete/clear/list), so this passes through.
      return { line: `  await supersurf.storage.${String(rest.action ?? 'get')}(${obj({ type: rest.type, key: rest.key, value: rest.value })});`, manual: false };
    case 'browser_performance_metrics':
      return { line: '  await supersurf.perf();', manual: false };
    case 'browser_list_extensions':
      return { line: '  await supersurf.extensions();', manual: false };
    default:
      return {
        line: `  // TODO: no client equivalent for ${step.tool} — ${JSON.stringify(step.params)}`,
        manual: true,
      };
  }
}

/** First navigate step's URL, else the first step carrying a `url` field. */
function startingPointOf(pb: LegacyPlaybook): string | null {
  const nav = pb.steps.find(s => s.tool === 'browser_navigate' && typeof s.params?.url === 'string');
  const raw = (nav?.params.url as string | undefined) ?? pb.steps.find(s => typeof s.url === 'string')?.url;
  if (!raw) return null;
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function toScript(pb: LegacyPlaybook): string {
  const metaLines = [`  description: ${q(pb.purpose || pb.name)},`];
  if (pb.profile) metaLines.push(`  profile: ${q(pb.profile)},`);
  const sp = startingPointOf(pb);
  if (sp) metaLines.push(`  startingPoint: ${q(sp)},`);

  const bodyLines = pb.steps.map(s => stepToSource(s).line);

  return [
    `// Migrated from ${pb.name}.json (recorded ${new Date(pb.createdAt).toISOString()}).`,
    '// A recording has no parameters. Add `params` to `meta` and replace the',
    '// hard-coded values below to make this reusable.',
    '',
    'export const meta = {',
    ...metaLines,
    '};',
    '',
    'export default async function ({ supersurf }) {',
    ...bodyLines,
    '}',
    '',
  ].join('\n');
}

/** Convert every legacy JSON playbook in the directory. Returns an exit code. */
export async function runMigrate(flags: { dryRun?: boolean } = {}, opts: RunOpts = {}): Promise<number> {
  const log = opts.log ?? console.log;
  const dir = getPlaybooksDir();

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  } catch {
    files = [];
  }

  if (files.length === 0) {
    log(`No legacy JSON playbooks in ${dir}.`);
    return 0;
  }

  let failed = 0;
  for (const file of files) {
    const src = path.join(dir, file);
    let pb: LegacyPlaybook;
    try {
      pb = JSON.parse(fs.readFileSync(src, 'utf8'));
      if (!pb || !Array.isArray(pb.steps)) throw new Error('not a playbook (no steps array)');
    } catch (err: any) {
      log(`✗ ${file} — could not read: ${err?.message ?? String(err)}`);
      failed++;
      continue;
    }

    const name = normalizeName(pb.name || file.replace(/\.json$/, ''));
    const dest = playbookFile(name);
    if (fs.existsSync(dest)) {
      log(`- ${name} — skipped, ${path.basename(dest)} already exists`);
      continue;
    }

    const source = toScript({ ...pb, name });
    const manual = pb.steps.filter(s => stepToSource(s).manual).length;
    const note = manual > 0 ? ` — ${manual} ${manual === 1 ? 'step needs' : 'steps need'} hand-finishing` : '';

    if (flags.dryRun) {
      log(`  would write ${path.basename(dest)} (${pb.steps.length} steps)${note}`);
      continue;
    }

    fs.writeFileSync(dest, source, { mode: 0o600 });
    log(`✓ ${name} — ${path.basename(dest)} (${pb.steps.length} steps)${note}`);
  }

  log('');
  log('The JSON files were left in place. Review each script, add `params` where you');
  log('want reuse, then `supersurf playbook validate` and delete the .json yourself.');
  return failed > 0 ? 1 : 0;
}
