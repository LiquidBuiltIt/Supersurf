#!/usr/bin/env npx tsx
/**
 * Publish extension to Chrome Web Store.
 * Builds the extension, zips it, uploads, and publishes.
 *
 * Usage:
 *   npm run cws.publish              # upload + publish
 *   npm run cws.publish -- --draft   # upload only (no publish)
 *
 * Prerequisites:
 *   - Run `npx tsx scripts/cws.auth.ts` first to get .cws-token
 *   - Extension must already exist on CWS (this updates, doesn't create)
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';

const green = '\x1b[32m';
const yellow = '\x1b[33m';
const cyan = '\x1b[36m';
const red = '\x1b[31m';
const reset = '\x1b[0m';

const root = resolve(__dirname, '..');
const extDir = resolve(root, 'extension');
const tokenPath = resolve(root, '.cws-token');
const zipPath = resolve(extDir, 'supersurf-extension.zip');

const EXTENSION_ID = 'falcdhojcinkkbffgnipppcdoaehgpek';

// Load credentials
const credsFile = readFileSync(resolve(root, 'client_secret_561052999589-nvnmjf166s07qv5bo0fonqhueml8itoa.apps.googleusercontent.com.json'), 'utf8');
const creds = JSON.parse(credsFile).installed;
const CLIENT_ID = creds.client_id;
const CLIENT_SECRET = creds.client_secret;

// Load refresh token
if (!existsSync(tokenPath)) {
  console.error(`${red}.cws-token not found. Run the auth setup first:${reset}`);
  console.error(`  ${cyan}npx tsx scripts/cws.auth.ts${reset}`);
  process.exit(1);
}
const { refresh_token } = JSON.parse(readFileSync(tokenPath, 'utf8'));

const isDraft = process.argv.includes('--draft');

async function getAccessToken(): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  const data = await res.json() as any;
  if (data.error) {
    throw new Error(`Token refresh failed: ${data.error_description || data.error}`);
  }
  return data.access_token;
}

async function upload(token: string): Promise<void> {
  console.log(`${cyan}Uploading to Chrome Web Store...${reset}`);

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
    console.error(`${red}Upload failed:${reset}`);
    for (const err of data.itemError || []) {
      console.error(`  - ${err.error_detail}`);
    }
    process.exit(1);
  }

  console.log(`${green}Upload successful${reset} (state: ${data.uploadState})`);
}

async function publish(token: string): Promise<void> {
  console.log(`${cyan}Publishing...${reset}`);

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
    console.error(`${red}Publish failed: ${data.error.message}${reset}`);
    process.exit(1);
  }

  const status = data.status?.[0] || 'OK';
  if (status === 'OK' || status === 'PUBLISHED_WITH_FRICTION_WARNING') {
    console.log(`${green}Published successfully!${reset}`);
    if (data.statusDetail) {
      for (const detail of data.statusDetail) {
        console.log(`  ${yellow}${detail}${reset}`);
      }
    }
  } else {
    console.error(`${red}Publish status: ${status}${reset}`);
    if (data.statusDetail) {
      for (const detail of data.statusDetail) {
        console.error(`  - ${detail}`);
      }
    }
    process.exit(1);
  }
}

async function main() {
  const version = JSON.parse(readFileSync(resolve(extDir, 'manifest.json'), 'utf8')).version;
  console.log(`\n${cyan}SuperSurf v${version} → Chrome Web Store${reset}\n`);

  // Build extension
  console.log(`${cyan}Building extension...${reset}`);
  execSync('npm run build.extension', { cwd: root, stdio: 'inherit' });

  // Zip — only include what CWS needs
  console.log(`${cyan}Creating zip...${reset}`);
  execSync(
    `cd "${extDir}" && rm -f supersurf-extension.zip && zip -r supersurf-extension.zip manifest.json dist/ assets/ -x "*.DS_Store"`,
    { stdio: 'inherit' }
  );

  // Get access token
  const token = await getAccessToken();

  // Upload
  await upload(token);

  // Publish (unless --draft)
  if (isDraft) {
    console.log(`\n${yellow}Draft mode — skipping publish. Review at:${reset}`);
    console.log(`  ${cyan}https://chrome.google.com/webstore/devconsole${reset}\n`);
  } else {
    await publish(token);
    console.log(`\n${green}Done!${reset} Extension v${version} is live.\n`);
  }
}

main().catch((err) => {
  console.error(`${red}${err.message}${reset}`);
  process.exit(1);
});
