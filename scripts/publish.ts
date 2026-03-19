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
 *   2. Check HEAD is a version tag commit + clean working tree
 *   3. git push && git push --tags
 *   4. npm publish daemon + server
 *   5. Build extension zip + upload + publish to CWS
 */

import { readFileSync, existsSync } from 'fs';
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

const EXTENSION_ID = 'falcdhojcinkkbffgnipppcdoaehgpek';
const isDry = process.argv.includes('--dry');
const noGithub = process.argv.includes('--no-github');

const git = (cmd: string) => execSync(cmd, { cwd: root, encoding: 'utf8' }).trim();
const run = (cmd: string) => execSync(cmd, { cwd: root, stdio: 'inherit' });

// ── Result tracking ──────────────────────────────────────────

type Step = 'github' | 'npm:daemon' | 'npm:server' | 'cws';
const results: Record<Step, 'pending' | 'success' | 'failed' | 'skipped'> = {
  'github': 'pending',
  'npm:daemon': 'pending',
  'npm:server': 'pending',
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

  // 2. Git checks (skipped with --no-github)
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

    const headSha = git('git rev-parse HEAD');
    let tagSha: string;
    try {
      tagSha = git(`git rev-parse v${versionMatch[1]}`);
    } catch {
      console.error(`\n${red}Tag v${versionMatch[1]} does not exist.${reset}`);
      console.error(`  The version.bump script should have created it. Something is off.\n`);
      process.exit(1);
    }
    if (headSha !== tagSha) {
      console.error(`\n${red}Tag v${versionMatch[1]} does not point to HEAD.${reset}`);
      console.error(`  Tag points to: ${tagSha.slice(0, 8)}`);
      console.error(`  HEAD is:       ${headSha.slice(0, 8)}\n`);
      process.exit(1);
    }
    ok(`Tag v${versionMatch[1]} exists on HEAD`);
  }

  // 3. Verify package versions match
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  const daemonVersion = JSON.parse(readFileSync(resolve(root, 'daemon/package.json'), 'utf8')).version;
  const serverVersion = JSON.parse(readFileSync(resolve(root, 'server/package.json'), 'utf8')).version;
  const extVersion = JSON.parse(readFileSync(resolve(extDir, 'manifest.json'), 'utf8')).version;

  if (daemonVersion !== version || serverVersion !== version || extVersion !== version) {
    console.error(`\n${red}Version mismatch across packages:${reset}`);
    console.error(`  Root:      ${version}`);
    console.error(`  Daemon:    ${daemonVersion}`);
    console.error(`  Server:    ${serverVersion}`);
    console.error(`  Extension: ${extVersion}\n`);
    process.exit(1);
  }
  ok(`All packages at v${version}`);

  return { version, cwsToken: refresh_token, clientId, clientSecret };
}

// ── Pipeline steps ───────────────────────────────────────────

function pushToGitHub() {
  info('Pushing to GitHub...');
  try {
    run('git push && git push --tags');
    results['github'] = 'success';
    ok('Pushed commits and tags');
  } catch (err) {
    recordFailure('github', err);
  }
}

function publishNpm(pkg: 'daemon' | 'server') {
  const step: Step = `npm:${pkg}`;
  const dir = resolve(root, pkg);
  info(`Publishing ${pkg} to npm...`);
  try {
    execSync('npm publish', { cwd: dir, stdio: 'inherit' });
    results[step] = 'success';
    ok(`${pkg} published to npm`);
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
      case 'npm:daemon':
        console.log(`    ${dim}Fix: resolve the issue and run:${reset}`);
        console.log(`    ${cyan}cd daemon && npm publish${reset}\n`);
        break;
      case 'npm:server':
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

  console.log(`\n${bold}Publishing v${version}${reset}\n`);

  // Step 1: GitHub
  if (noGithub) {
    results['github'] = 'skipped';
  } else {
    pushToGitHub();
  }

  // Step 2: npm (daemon first — server depends on it)
  publishNpm('daemon');
  publishNpm('server');

  // Step 3: Chrome Web Store
  await publishCWS(clientId, clientSecret, cwsToken);

  // Summary
  printSummary(version);
}

main().catch((err) => {
  console.error(`${red}Unexpected error: ${err.message}${reset}`);
  process.exit(1);
});
