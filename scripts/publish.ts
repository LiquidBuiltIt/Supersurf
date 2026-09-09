#!/usr/bin/env npx tsx
/**
 * Unified release pipeline. Publishes to GitHub, npm, and Chrome Web Store.
 *
 * Prerequisites:
 *   1. Run `npm run version.bump <patch|minor|major> "message"` first
 *   2. Run `npm run cws.auth` once to set up CWS credentials
 *
 * Usage:
 *   npm run publish               # full release: github + npm + cws
 *   npm run publish -- --dry      # pre-flight checks only, no publishing
 *   npm run publish -- --no-github # skip git push, publish npm + cws only
 *
 * Pipeline:
 *   1. Check CWS auth (.cws-token + token refresh)
 *   2. Check HEAD is a version-bump commit + clean working tree
 *   3. Create git tag (idempotent — skipped if tag already on HEAD)
 *   4. git push && git push --tags (deletes local tag if push fails)
 *   5. npm publish daemon + server
 *   6. Compile the four supersurf binaries, create the GitHub release, upload
 *      them as assets (docs/install.sh downloads these)
 *   7. Build extension zip + upload + publish to CWS
 *
 * Tags are created here, not by version.bump, so they only exist for versions
 * that were actually shipped.
 */

import { readFileSync, existsSync, statSync, createReadStream } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';

// ── ANSI ─────────────────────────────────────────────────────

const green = '\x1b[32m';
const yellow = '\x1b[33m';
const cyan = '\x1b[36m';
const red = '\x1b[31m';
const dim = '\x1b[2m';
const bold = '\x1b[1m';
const reset = '\x1b[0m';

const ok = (msg: string) => console.log(`  ${green}✓${reset} ${msg}`);
const fail = (msg: string) => console.error(`  ${red}✗${reset} ${msg}`);
const info = (msg: string) => console.log(`  ${cyan}→${reset} ${msg}`);
const warn = (msg: string) => console.log(`  ${yellow}!${reset} ${msg}`);

// ── Config ───────────────────────────────────────────────────

const root = resolve(__dirname, '..');
const extDir = resolve(root, 'extension');
const tokenPath = resolve(root, '.cws-token');
const zipPath = resolve(extDir, 'supersurf-extension.zip');

// GITHUB_API_TOKEN lives in the gitignored repo-root .env, not the shell
// environment: an exported var is inherited by every process the user starts,
// including every npm lifecycle script in node_modules. Read here so the token
// is in scope only for a release. A real shell env var still wins.
if (!process.env.GITHUB_API_TOKEN && existsSync(resolve(root, '.env'))) {
  const line = readFileSync(resolve(root, '.env'), 'utf8')
    .split('\n')
    .find((l) => /^\s*GITHUB_API_TOKEN\s*=/.test(l));
  if (line) {
    process.env.GITHUB_API_TOKEN = line
      .slice(line.indexOf('=') + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
  }
}

const EXTENSION_ID = 'falcdhojcinkkbffgnipppcdoaehgpek';
const REPO = 'LiquidBuiltIt/Supersurf';
const cliBuildDir = resolve(root, 'cli', 'build');
// Asset names are a contract with docs/install.sh, which builds the filename
// from `uname` output as `supersurf-<os>-<arch>`. Renaming one side breaks
// every install command already published.
const BINARY_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];
const isDry = process.argv.includes('--dry');
const noGithub = process.argv.includes('--no-github');

const git = (cmd: string) => execSync(cmd, { cwd: root, encoding: 'utf8' }).trim();
const run = (cmd: string) => execSync(cmd, { cwd: root, stdio: 'inherit' });

// ── Result tracking ──────────────────────────────────────────

type Step = 'github' | 'github:release' | 'npm:supersurf' | 'cws';
const results: Record<Step, 'pending' | 'success' | 'failed' | 'skipped'> = {
  'github': 'pending',
  'github:release': 'pending',
  'npm:supersurf': 'pending',
  'cws': 'pending',
};
const errors: Record<string, string> = {};

function recordFailure(step: Step, error: unknown) {
  results[step] = 'failed';
  errors[step] = error instanceof Error ? error.message : String(error);
  fail(`${step}: ${errors[step]}`);
}

// ── CWS helpers ──────────────────────────────────────────────

function loadCWSCredentials() {
  const credsPath = resolve(root, 'client_secret_561052999589-nvnmjf166s07qv5bo0fonqhueml8itoa.apps.googleusercontent.com.json');
  if (!existsSync(credsPath)) {
    throw new Error('CWS client credentials not found. Place client_secret_*.json in project root.');
  }
  const creds = JSON.parse(readFileSync(credsPath, 'utf8')).installed;
  return { clientId: creds.client_id, clientSecret: creds.client_secret };
}

async function getAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json() as any;
  if (data.error) {
    throw new Error(`Token refresh failed: ${data.error_description || data.error}`);
  }
  return data.access_token;
}

async function cwsUpload(token: string): Promise<void> {
  const zipBuffer = readFileSync(zipPath);
  const res = await fetch(
    `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${EXTENSION_ID}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-goog-api-version': '2',
      },
      body: zipBuffer,
    }
  );
  const data = await res.json() as any;
  if (data.uploadState === 'FAILURE') {
    const details = (data.itemError || []).map((e: any) => e.error_detail).join('; ');
    throw new Error(`Upload rejected: ${details}`);
  }
}

async function cwsPublish(token: string): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/chromewebstore/v1.1/items/${EXTENSION_ID}/publish`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-goog-api-version': '2',
        'Content-Length': '0',
      },
    }
  );
  const data = await res.json() as any;
  if (data.error) {
    throw new Error(data.error.message);
  }
  const status = data.status?.[0] || 'OK';
  if (status !== 'OK' && status !== 'PUBLISHED_WITH_FRICTION_WARNING') {
    const details = (data.statusDetail || []).join('; ');
    throw new Error(`Publish status: ${status}. ${details}`);
  }
  if (data.statusDetail?.length) {
    for (const detail of data.statusDetail) {
      warn(detail);
    }
  }
}

// ── Pre-flight checks ────────────────────────────────────────

async function preflight(): Promise<{ version: string; cwsToken: string; clientId: string; clientSecret: string }> {
  console.log(`\n${bold}Pre-flight checks${reset}\n`);

  // 1. CWS credentials
  const { clientId, clientSecret } = loadCWSCredentials();
  ok('CWS client credentials found');

  if (!existsSync(tokenPath)) {
    console.error(`\n${red}.cws-token not found.${reset} Run auth setup first:`);
    console.error(`  ${cyan}npm run cws.auth${reset}\n`);
    process.exit(1);
  }
  const { refresh_token } = JSON.parse(readFileSync(tokenPath, 'utf8'));

  // Verify token actually works
  await getAccessToken(clientId, clientSecret, refresh_token);
  ok('CWS refresh token valid');

  // 2. npm registry auth — must be logged in to publish daemon + server
  try {
    const npmUser = execSync('npm whoami --registry=https://registry.npmjs.org/', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    ok(`npm logged in as ${npmUser}`);
  } catch {
    console.error(`\n${red}Not logged in to npm.${reset} Run:`);
    console.error(`  ${cyan}npm login${reset}\n`);
    process.exit(1);
  }

  // 3. Git checks (skipped with --no-github)
  if (noGithub) {
    warn('--no-github: skipping git checks');
  } else {
    const status = git('git status --porcelain');
    if (status) {
      console.error(`\n${red}Working tree is dirty.${reset} Stage your changes and run version.bump first:`);
      console.error(`  ${cyan}npm run version.bump <patch|minor|major> "message"${reset}\n`);
      console.error(`${dim}${status}${reset}\n`);
      process.exit(1);
    }
    ok('Working tree clean');

    const headMsg = git('git log --oneline -1 --format=%s');
    const versionMatch = headMsg.match(/^v(\d+\.\d+\.\d+)/);
    if (!versionMatch) {
      console.error(`\n${red}HEAD commit is not a version bump.${reset}`);
      console.error(`  Last commit: "${headMsg}"`);
      console.error(`  Run ${cyan}npm run version.bump <patch|minor|major> "message"${reset} first.\n`);
      process.exit(1);
    }
    ok(`HEAD is version bump: v${versionMatch[1]}`);

    // Tag may or may not exist yet — version.bump no longer creates it.
    // If a tag with this version exists, it must point at HEAD (otherwise
    // we'd be re-using a version number for a different commit).
    const headSha = git('git rev-parse HEAD');
    let existingTagSha: string | null = null;
    try {
      existingTagSha = git(`git rev-parse v${versionMatch[1]}`);
    } catch { /* tag does not exist — that's the normal case */ }

    if (existingTagSha && existingTagSha !== headSha) {
      console.error(`\n${red}Tag v${versionMatch[1]} already exists but points elsewhere.${reset}`);
      console.error(`  Tag points to: ${existingTagSha.slice(0, 8)}`);
      console.error(`  HEAD is:       ${headSha.slice(0, 8)}`);
      console.error(`  Bump to a new version or delete the conflicting tag.\n`);
      process.exit(1);
    }
    if (existingTagSha) {
      ok(`Tag v${versionMatch[1]} already on HEAD (idempotent re-run)`);
    } else {
      ok(`No conflicting tag for v${versionMatch[1]}`);
    }
  }

  // 4. Verify package versions match
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  const serverVersion = JSON.parse(readFileSync(resolve(root, 'server/package.json'), 'utf8')).version;
  const extVersion = JSON.parse(readFileSync(resolve(extDir, 'manifest.json'), 'utf8')).version;
  // The CLI's version is not cosmetic: it is compiled into the binary and used
  // as the npx pin, so `supersurf mcp` launches `supersurf-mcp@<this number>`.
  // A CLI lagging the rest of the release ships a binary that fetches the
  // previous server.
  const cliVersion = JSON.parse(readFileSync(resolve(root, 'cli/package.json'), 'utf8')).version;

  if (serverVersion !== version || extVersion !== version || cliVersion !== version) {
    console.error(`\n${red}Version mismatch across packages:${reset}`);
    console.error(`  Root:      ${version}`);
    console.error(`  Server:    ${serverVersion}`);
    console.error(`  Extension: ${extVersion}`);
    console.error(`  CLI:       ${cliVersion}\n`);
    process.exit(1);
  }
  ok(`All packages at v${version}`);

  // 5. The version must not already be on npm.
  //
  // This lives here rather than in cli/build.ts on purpose. Between releases
  // the repo version IS the published version, so a build-time refusal would
  // break every routine dev compile, and a build-time warning would fire on
  // every one of them and train people to ignore it. Only the release path can
  // tell the difference.
  //
  // The stake is the npx pin: a binary compiled at an already-published version
  // shells out to that published package, which is the one this release exists
  // to replace.
  try {
    execSync(`npm view supersurf-mcp@${version} version`, { stdio: ['ignore', 'pipe', 'pipe'] });
    console.error(`\n${red}supersurf-mcp@${version} is already published.${reset}`);
    console.error(`  A binary compiled at this version pins its npx calls to the`);
    console.error(`  package already on the registry, so it would launch the very`);
    console.error(`  release you are replacing.`);
    console.error(`  Run ${cyan}npm run version.bump <patch|minor|major> "message"${reset} first.\n`);
    process.exit(1);
  } catch (err: any) {
    // Only a genuine 404 clears this gate. Any other non-zero exit — no
    // network, registry down, auth error — must not be read as "not
    // published", or the one check standing between a broken pin and a
    // release fails open exactly when the registry is unreachable.
    const stderr = String(err?.stderr ?? '') + String(err?.stdout ?? '');
    if (/E404|No match found for version/.test(stderr)) {
      ok(`v${version} is not on npm yet`);
    } else {
      console.error(`\n${red}Could not determine whether v${version} is published.${reset}`);
      console.error(`  ${dim}${stderr.trim().split('\n').slice(-3).join('\n  ')}${reset}`);
      console.error(`  Refusing to release on an unverified version.\n`);
      process.exit(1);
    }
  }

  // 6. GitHub token — the release assets are what `install.sh` downloads, so a
  // release without them is a published install command that 404s.
  if (!noGithub && !process.env.GITHUB_API_TOKEN) {
    console.error(`\n${red}GITHUB_API_TOKEN is not set.${reset} The release assets cannot be uploaded without it.`);
    console.error(`  Create a token with ${cyan}contents: write${reset} on ${REPO}, then add it to ${cyan}.env${reset} at the repo root:`);
    console.error(`  ${cyan}GITHUB_API_TOKEN=...${reset}\n`);
    process.exit(1);
  }
  if (!noGithub) ok('GITHUB_API_TOKEN present');

  return { version, cwsToken: refresh_token, clientId, clientSecret };
}

// ── Pipeline steps ───────────────────────────────────────────

function pushToGitHub(version: string) {
  const tag = `v${version}`;
  let createdTagThisRun = false;

  // Create the tag if it doesn't already exist (idempotent for retry runs).
  // Pre-flight already verified that any existing tag points at HEAD.
  let tagExists = false;
  try {
    git(`git rev-parse ${tag}`);
    tagExists = true;
  } catch { /* tag does not exist yet */ }

  if (!tagExists) {
    try {
      run(`git tag ${tag}`);
      createdTagThisRun = true;
      ok(`Created tag ${tag}`);
    } catch (err) {
      recordFailure('github', err);
      return;
    }
  }

  info('Pushing to GitHub...');
  try {
    run('git push && git push --tags');
    results['github'] = 'success';
    ok('Pushed commits and tags');
  } catch (err) {
    // If we created the tag in this run and push failed, delete it so the
    // next retry doesn't see a stale local tag pointing at an unpushed commit.
    if (createdTagThisRun) {
      try {
        run(`git tag -d ${tag}`);
        warn(`Push failed — local tag ${tag} removed for clean retry`);
      } catch { /* best effort */ }
    }
    recordFailure('github', err);
  }
}

/**
 * Compile the four `supersurf` binaries and attach them to the GitHub release
 * for this tag.
 *
 * This runs AFTER `npm publish`, not before. Each binary pins its npx calls to
 * its own version, so a downloadable binary whose `supersurf-mcp@<version>` is
 * not on the registry yet is a binary that fails on first run. Publishing npm
 * first makes that window zero.
 *
 * `docs/install.sh` resolves an asset by `supersurf-<os>-<arch>`, built from
 * `uname` output, and it reads `releases/latest/download/`. That is the whole
 * contract: the names below and the release not being a draft.
 */
async function publishGitHubRelease(version: string) {
  const step: Step = 'github:release';
  const tag = `v${version}`;
  const token = process.env.GITHUB_API_TOKEN;
  const api = async (url: string, init: RequestInit) => {
    const res = await fetch(url, {
      ...init,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} -> ${res.status} ${await res.text()}`);
    return res.json() as any;
  };

  try {
    info('Compiling supersurf binaries...');
    run('npm run build.cli');

    for (const target of BINARY_TARGETS) {
      const path = resolve(cliBuildDir, `supersurf-${target}`);
      if (!existsSync(path)) throw new Error(`missing binary: ${path}`);
    }
    ok(`Compiled ${BINARY_TARGETS.length} binaries`);

    info(`Creating GitHub release ${tag}...`);
    const release = await api(`https://api.github.com/repos/${REPO}/releases`, {
      method: 'POST',
      body: JSON.stringify({ tag_name: tag, name: tag, generate_release_notes: true }),
    });
    ok(`Release ${tag} created`);

    for (const target of BINARY_TARGETS) {
      const name = `supersurf-${target}`;
      const path = resolve(cliBuildDir, name);
      const size = statSync(path).size;
      info(`Uploading ${name} (${Math.round(size / 1024 / 1024)} MB)...`);
      // The upload host is uploads.github.com, not api.github.com, and it
      // wants the raw bytes with an explicit length — it does not accept
      // chunked transfer encoding.
      await api(`https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
        body: createReadStream(path) as any,
        duplex: 'half',
      } as RequestInit);
      ok(`${name} uploaded`);
    }

    results[step] = 'success';
  } catch (err) {
    recordFailure(step, err);
  }
}

function publishNpm() {
  const step: Step = 'npm:supersurf';
  // Two published packages: daemon first (server depends on it), then server.
  try {
    for (const pkg of ['daemon', 'server']) {
      info(`Publishing ${pkg} to npm...`);
      execSync('npm publish', { cwd: resolve(root, pkg), stdio: 'inherit' });
      ok(`${pkg} published to npm`);
    }
    results[step] = 'success';
  } catch (err) {
    recordFailure(step, err);
  }
}

async function publishCWS(clientId: string, clientSecret: string, refreshToken: string) {
  info('Building extension...');
  try {
    run('npm run build.extension');
    execSync(
      `cd "${extDir}" && rm -f supersurf-extension.zip && zip -r supersurf-extension.zip manifest.json dist/ assets/ -x "*.DS_Store"`,
      { stdio: 'inherit' },
    );

    info('Uploading to Chrome Web Store...');
    const token = await getAccessToken(clientId, clientSecret, refreshToken);
    await cwsUpload(token);
    ok('Extension uploaded');

    info('Publishing on Chrome Web Store...');
    await cwsPublish(token);
    results['cws'] = 'success';
    ok('Extension published');
  } catch (err) {
    recordFailure('cws', err);
  }
}

// ── Summary ──────────────────────────────────────────────────

function printSummary(version: string) {
  const failed = Object.entries(results).filter(([, s]) => s === 'failed');
  const succeeded = Object.entries(results).filter(([, s]) => s === 'success');

  console.log(`\n${bold}Release v${version} — Summary${reset}\n`);

  for (const [step, status] of Object.entries(results)) {
    const icon = status === 'success' ? `${green}✓${reset}` :
                 status === 'failed'  ? `${red}✗${reset}` :
                 status === 'skipped' ? `${yellow}-${reset}` :
                 `${dim}?${reset}`;
    console.log(`  ${icon} ${step}`);
  }

  if (failed.length === 0) {
    console.log(`\n${green}All targets published successfully.${reset}\n`);
    return;
  }

  console.log(`\n${yellow}${failed.length} target(s) failed. Manual resolution required:${reset}\n`);

  for (const [step] of failed) {
    const err = errors[step];
    console.log(`  ${red}${step}${reset}: ${err}`);

    switch (step) {
      case 'github':
        console.log(`    ${dim}Fix: resolve the issue and run:${reset}`);
        console.log(`    ${cyan}git push && git push --tags${reset}\n`);
        break;
      case 'github:release':
        console.log(`    ${dim}Fix: resolve the issue and re-run publish, or attach${reset}`);
        console.log(`    ${dim}cli/build/supersurf-* to the release by hand:${reset}`);
        console.log(`    ${cyan}https://github.com/${REPO}/releases/tag/v${version}${reset}\n`);
        break;
      case 'npm:supersurf':
        console.log(`    ${dim}Fix: resolve the issue and run:${reset}`);
        console.log(`    ${cyan}cd server && npm publish${reset}\n`);
        break;
      case 'cws':
        console.log(`    ${dim}Fix: resolve the issue and run:${reset}`);
        console.log(`    ${cyan}npm run cws.publish${reset}\n`);
        break;
    }
  }

  // If github failed, everything downstream is suspect
  if (results['github'] === 'failed') {
    warn('GitHub push failed — npm and CWS may have published a version that isn\'t on GitHub yet.');
  }

  process.exit(1);
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const { version, cwsToken, clientId, clientSecret } = await preflight();

  if (isDry) {
    console.log(`\n${green}All pre-flight checks passed.${reset} Run without --dry to publish.\n`);
    process.exit(0);
  }

  // ── Deployment timer — 10s window to abort with Ctrl-C ──
  console.log(`\n${bold}${yellow}About to publish v${version} to GitHub + npm + Chrome Web Store.${reset}`);
  console.log(`${dim}Press Ctrl-C within 10 seconds to abort.${reset}\n`);
  for (let i = 10; i > 0; i--) {
    process.stdout.write(`\r  ${cyan}→${reset} Deploying in ${bold}${i}${reset}s... `);
    await new Promise((r) => setTimeout(r, 1000));
  }
  process.stdout.write(`\r  ${green}✓${reset} Deploying now.            \n`);

  console.log(`\n${bold}Publishing v${version}${reset}\n`);

  // Step 1: GitHub (creates tag, then pushes)
  if (noGithub) {
    results['github'] = 'skipped';
  } else {
    pushToGitHub(version);
  }

  // Step 2: npm — single package now
  publishNpm();

  // Step 3: GitHub release assets. After npm on purpose — see the function.
  if (noGithub) {
    results['github:release'] = 'skipped';
  } else {
    await publishGitHubRelease(version);
  }

  // Step 4: Chrome Web Store
  await publishCWS(clientId, clientSecret, cwsToken);

  // Summary
  printSummary(version);
}

main().catch((err) => {
  console.error(`${red}Unexpected error: ${err.message}${reset}`);
  process.exit(1);
});
