#!/usr/bin/env npx tsx
/**
 * One-time OAuth setup for Chrome Web Store API.
 * Opens a browser for Google consent, captures the auth code via a local
 * HTTP server, exchanges it for a refresh token, and saves it to .cws-token.
 *
 * Usage:
 *   npx tsx scripts/cws.auth.ts
 *
 * Prerequisites:
 *   - client_secret_*.json in project root (Google OAuth Desktop credentials)
 *   - Chrome Web Store API enabled in Google Cloud Console
 */

import { createServer } from 'http';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';

const green = '\x1b[32m';
const cyan = '\x1b[36m';
const red = '\x1b[31m';
const reset = '\x1b[0m';

const root = resolve(__dirname, '..');
const tokenPath = resolve(root, '.cws-token');

// Find the client secret JSON
const credsFile = readFileSync(resolve(root, 'client_secret_561052999589-nvnmjf166s07qv5bo0fonqhueml8itoa.apps.googleusercontent.com.json'), 'utf8');
const creds = JSON.parse(credsFile).installed;

const CLIENT_ID = creds.client_id;
const CLIENT_SECRET = creds.client_secret;
const REDIRECT_URI = 'http://localhost:8085';
const SCOPES = 'https://www.googleapis.com/auth/chromewebstore';

const authUrl =
  `https://accounts.google.com/o/oauth2/auth` +
  `?client_id=${CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&access_type=offline` +
  `&prompt=consent`;

console.log(`\n${cyan}Opening browser for Google authorization...${reset}\n`);

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, REDIRECT_URI);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<h2>Authorization failed: ${error}</h2><p>You can close this tab.</p>`);
    console.error(`${red}Authorization failed: ${error}${reset}`);
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<h2>No authorization code received.</h2>`);
    return;
  }

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  const tokenData = await tokenRes.json() as any;

  if (tokenData.error) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<h2>Token exchange failed: ${tokenData.error}</h2><p>${tokenData.error_description}</p>`);
    console.error(`${red}Token exchange failed: ${tokenData.error_description}${reset}`);
    process.exit(1);
  }

  if (!tokenData.refresh_token) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<h2>No refresh token returned.</h2><p>Try revoking app access at myaccount.google.com/permissions and re-running.</p>`);
    console.error(`${red}No refresh token returned. Revoke app access and retry.${reset}`);
    process.exit(1);
  }

  // Save refresh token
  writeFileSync(tokenPath, JSON.stringify({ refresh_token: tokenData.refresh_token }, null, 2) + '\n');
  console.log(`${green}Refresh token saved to .cws-token${reset}`);

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<h2>Authorization successful!</h2><p>You can close this tab.</p>`);

  server.close();
  process.exit(0);
});

server.listen(8085, () => {
  console.log(`Listening on ${REDIRECT_URI} for OAuth callback...\n`);
  console.log(`${cyan}Open this URL in your browser:${reset}\n\n${authUrl}\n`);
  // Try to open automatically as well
  try { execSync(`open "${authUrl}"`); } catch {}
});
