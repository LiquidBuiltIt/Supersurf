/**
 * Post-tsc build step — copies static assets (HTML, CSS, PNG) from src/ to dist/
 * Preserves directory structure so manifest references work correctly.
 * Also bundles the changelog page's data file: `dist/pages/changelog.json`,
 * generated at build time from CHANGELOG.md (released sections only — the
 * changelog page never sees `## Unreleased`) so the page never does a
 * runtime network fetch of the changelog itself.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __buildDir = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__buildDir, 'src');
const DIST_DIR = path.resolve(__buildDir, 'dist');
const REPO_ROOT = path.resolve(__buildDir, '..');

const ASSET_EXTENSIONS = new Set(['.html', '.css', '.png']);

function copyAssets(dir: string): number {
  let copied = 0;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const srcPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Retired-but-kept code lives in `<name>.old/` and is excluded from tsc
      // (extension/tsconfig.json). Skip its assets too, or dead HTML/CSS still
      // ships in the packaged extension.
      if (entry.name.endsWith('.old')) continue;
      copied += copyAssets(srcPath);
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!ASSET_EXTENSIONS.has(ext)) continue;

    const relativePath = path.relative(SRC_DIR, srcPath);
    const destPath = path.join(DIST_DIR, relativePath);

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);
    console.log(`  ${relativePath}`);
    copied++;
  }

  return copied;
}

/** Runs `scripts/changelog.ts json`, drops the Unreleased section, and
 *  writes the result to `dist/pages/changelog.json`. */
function writeChangelogJson(): void {
  const scriptPath = path.join(REPO_ROOT, 'scripts', 'changelog.ts');
  const raw = execFileSync('npx', ['tsx', scriptPath, 'json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(raw) as { sections: Array<{ version: string }> };
  const released = { sections: parsed.sections.filter((s) => s.version !== 'Unreleased') };

  const destPath = path.join(DIST_DIR, 'pages', 'changelog.json');
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, JSON.stringify(released, null, 2) + '\n', 'utf8');
  console.log(`  pages/changelog.json (${released.sections.length} released version(s))`);
}

console.log('Copying static assets to dist/:');
const count = copyAssets(SRC_DIR);
console.log(`\n${count} asset(s) copied.`);

console.log('\nBundling changelog data:');
writeChangelogJson();

console.log('\nBuild complete.');
