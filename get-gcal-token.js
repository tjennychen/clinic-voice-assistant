/**
 * One-time local script to get a Google Calendar refresh token.
 *
 * Run this ONCE on your local machine:
 *   node get-gcal-token.js
 *
 * Then copy the refresh_token into your .env as GOOGLE_REFRESH_TOKEN.
 * You never need to run this again — the refresh token doesn't expire
 * unless you revoke it.
 *
 * Prerequisites:
 *   1. Google Cloud project with Calendar API enabled
 *   2. OAuth2 credentials (Desktop app type) — download the JSON
 *   3. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env
 */

'use strict';

require('dotenv').config();
const { google } = require('googleapis');
const http = require('http');
const url = require('url');
const open = require('open').default || require('open');

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:3001/oauth2callback';
const SCOPES        = ['https://www.googleapis.com/auth/calendar'];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent', // Force consent screen to get refresh token every time
});

console.log('\nOpening browser for Google authorization...');
console.log('If the browser does not open, visit this URL manually:\n');
console.log(authUrl);
console.log('');

// Try to open browser automatically
try {
  const openModule = require('open');
  const openFn = typeof openModule === 'function' ? openModule : openModule.default;
  if (openFn) openFn(authUrl);
} catch {}

// Start a temporary local server to catch the OAuth callback
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname !== '/oauth2callback') {
    res.end('Not found');
    return;
  }

  const code = parsed.query.code;
  if (!code) {
    res.end('No code received.');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.end(`
      <h2>Success!</h2>
      <p>Copy this refresh token into your <code>.env</code> as <code>GOOGLE_REFRESH_TOKEN</code>:</p>
      <pre style="background:#f0f0f0;padding:12px;word-break:break-all">${tokens.refresh_token}</pre>
      <p>You can close this tab.</p>
    `);

    console.log('\n=== SUCCESS ===');
    console.log('Add this to your .env file:\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('\nDone! You can close the browser tab.');

    server.close();
    process.exit(0);
  } catch (err) {
    res.end(`Error: ${err.message}`);
    console.error('Token exchange error:', err.message);
    server.close();
    process.exit(1);
  }
});

server.listen(3001, () => {
  console.log('Waiting for Google to redirect back... (listening on port 3001)');
});
