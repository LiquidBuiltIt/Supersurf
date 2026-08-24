/**
 * @module pages/changelog
 *
 * "What's new" page opened on a major-version extension update. Reads the
 * previous version from its own `?from=` query param, fetches the
 * build-time-bundled `changelog.json` (same directory, no network — see
 * `extension/build.ts` and `npm run changelog -- json` in the root build),
 * and renders every section between `from` (exclusive) and the running
 * manifest version (inclusive), newest first. Falls back to a link to the
 * full CHANGELOG on GitHub if `changelog.json` is missing, unreadable, or
 * has nothing to show.
 */

import { sliceSections, renderBulletHtml, type ChangelogData } from './changelog-render.js';

function showFallback(): void {
  const fallback = document.getElementById('fallback');
  const sectionsEl = document.getElementById('sections');
  if (fallback) fallback.hidden = false;
  if (sectionsEl) sectionsEl.hidden = true;
}

function renderSections(data: ChangelogData, from: string | null, curr: string): void {
  const sectionsEl = document.getElementById('sections');
  if (!sectionsEl) return;

  const sliced = sliceSections(data.sections, from, curr);

  if (sliced.length === 0) {
    showFallback();
    return;
  }

  const frag = document.createDocumentFragment();
  for (const section of sliced) {
    const block = document.createElement('div');
    block.className = 'version-block';

    const heading = document.createElement('h2');
    heading.className = 'version-heading';
    heading.textContent = section.date ? `${section.version} — ${section.date}` : section.version;
    block.appendChild(heading);

    if (section.summary) {
      const summary = document.createElement('p');
      summary.className = 'version-summary';
      summary.innerHTML = renderBulletHtml(section.summary);
      block.appendChild(summary);
    }

    const list = document.createElement('ul');
    list.className = 'bullet-list';
    for (const bullet of section.bullets) {
      const li = document.createElement('li');
      li.innerHTML = renderBulletHtml(bullet);
      list.appendChild(li);
    }
    block.appendChild(list);

    frag.appendChild(block);
  }
  sectionsEl.appendChild(frag);
}

async function init(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const from = params.get('from');
  const curr = chrome.runtime.getManifest().version;

  const currEl = document.getElementById('current-version');
  if (currEl) currEl.textContent = curr;
  const fromEl = document.getElementById('from-version');
  if (fromEl) fromEl.textContent = from ?? 'a previous version';

  try {
    const res = await fetch('changelog.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as ChangelogData;
    if (!data || !Array.isArray(data.sections)) throw new Error('malformed changelog.json');
    renderSections(data, from, curr);
  } catch {
    showFallback();
  }
}

init();
