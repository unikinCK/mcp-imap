// End-to-end test of the HTTP server: OAuth (DCR + PKCE + login + consent), Streamable HTTP and the web backend.
// The OAuth/web part always runs; MCP tool calls against a mailbox need IMAP_TEST_HOST (see integration.test.mjs).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import nodemailer from 'nodemailer';

const imapHost = process.env.IMAP_TEST_HOST;
const imapPort = process.env.IMAP_TEST_PORT ?? '3143';
const smtpPort = process.env.SMTP_TEST_PORT ?? '3025';
const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const port = 38000 + Math.floor(Math.random() * 1000);
const base = `http://localhost:${port}`;
const redirectUri = 'http://localhost:9/callback';
const dataDir = mkdtempSync(join(tmpdir(), 'mcp-imap-http-'));
const env = {
  PATH: process.env.PATH ?? '',
  MCP_IMAP_DB: join(dataDir, 'test.db'),
  MCP_IMAP_SECRET_KEY: randomBytes(32).toString('base64'),
  MCP_IMAP_PUBLIC_URL: base,
  MCP_IMAP_HTTP_PORT: String(port),
};
const mailUser = `http-${Date.now()}@example.com`;
const PASSWORD = 'correct horse battery';

/** Minimal browser: cookie jar + manual redirects. */
class Browser {
  cookies = new Map();
  async request(path, { method = 'GET', form } = {}) {
    const headers = { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(new URL(path, base), { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      this.cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
    return res;
  }
  csrf() {
    return decodeURIComponent(this.cookies.get('mcpimap_csrf') ?? '');
  }
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function registerClient() {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Test Client',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(res.status, 201);
  return res.json();
}

async function token(params) {
  const res = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, body: await res.json() };
}

/** Runs the full authorization code flow in the browser and returns the token response. */
async function authorize(browser, client, scopes) {
  const { verifier, challenge } = pkce();
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    resource: `${base}/mcp`,
  });
  let res = await browser.request(`/authorize?${query}`);
  assert.equal(res.status, 302);
  const consentPath = res.headers.get('location');
  assert.match(consentPath, /^\/oauth\/consent\?request=/);

  res = await browser.request(consentPath);
  assert.equal(res.status, 200, 'browser must be logged in');
  const html = await res.text();
  assert.match(html, /Test Client/);
  const requestId = new URL(consentPath, base).searchParams.get('request');

  const form = new URLSearchParams({ csrf: browser.csrf(), request: requestId, action: 'approve' });
  for (const s of scopes) form.append('scope', s);
  res = await browser.request('/oauth/consent', { method: 'POST', form });
  assert.equal(res.status, 303);
  const callback = new URL(res.headers.get('location'));
  assert.equal(callback.origin + callback.pathname, redirectUri);
  assert.equal(callback.searchParams.get('state'), 'xyz');
  const code = callback.searchParams.get('code');
  assert.ok(code);

  const result = await token({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: redirectUri,
    resource: `${base}/mcp`,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  // A code can only be used once.
  const replay = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id });
  assert.equal(replay.status, 400);
  return result.body;
}

async function mcpClient(accessToken) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: 'http-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

describe('http server', () => {
  let proc;
  const browser = new Browser();
  let client;

  before(async () => {
    execFileSync(process.execPath, [serverPath, 'user', 'add', 'alice'], { env, input: `${PASSWORD}\n`, stdio: 'pipe' });
    proc = spawn(process.execPath, [serverPath, 'serve', '--read-write'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    proc.stderr.on('data', (d) => (log += d));
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`${base}/healthz`)).ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`server did not start: ${log}`);
  });
  after(() => proc?.kill());

  test('rejects unauthenticated MCP requests with resource metadata hint', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate'), /resource_metadata="http:\/\/localhost:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  });

  test('publishes OAuth metadata', async () => {
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(prm.resource, `${base}/mcp`);
    assert.deepEqual(prm.authorization_servers, [`${base}/`]);
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(as.registration_endpoint, `${base}/register`);
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(as.scopes_supported, ['mail:read', 'mail:write', 'mail:send']);
  });

  test('login rejects wrong password and missing CSRF token', async () => {
    await browser.request('/login');
    let res = await browser.request('/login', { method: 'POST', form: { csrf: browser.csrf(), username: 'alice', password: 'wrong-password' } });
    assert.equal(res.status, 401);
    res = await browser.request('/login', { method: 'POST', form: { username: 'alice', password: PASSWORD } });
    assert.equal(res.status, 403);
  });

  test('consent redirects to login, then user logs in and adds a mail account', async () => {
    client = await registerClient();
    const { challenge } = pkce();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    let res = await browser.request(`/authorize?${query}`);
    res = await browser.request(res.headers.get('location'));
    assert.equal(res.status, 303);
    const loginUrl = new URL(res.headers.get('location'), base);
    assert.equal(loginUrl.pathname, '/login');

    const loginHtml = await (await browser.request(loginUrl.pathname + loginUrl.search)).text();
    assert.match(loginHtml, new RegExp(`<code>localhost:${port}</code>`), 'login page shows the server');
    assert.match(loginHtml, /connect <strong>Test Client<\/strong>/, 'login page shows the requesting app');
    res = await browser.request('/login', {
      method: 'POST',
      form: { csrf: browser.csrf(), username: 'alice', password: PASSWORD, next: loginUrl.searchParams.get('next') },
    });
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /^\/oauth\/consent/);

    res = await browser.request('/account/mail', {
      method: 'POST',
      form: {
        csrf: browser.csrf(),
        name: 'test',
        imap_host: imapHost ?? 'imap.invalid',
        imap_port: imapPort,
        imap_user: mailUser,
        imap_password: 'secret',
        smtp_host: imapHost ?? 'smtp.invalid',
        smtp_port: smtpPort,
        smtp_save_to_sent: '1',
      },
    });
    assert.equal(res.status, 303);
    const page = await (await browser.request('/account')).text();
    assert.match(page, new RegExp(mailUser.replace(/[.]/g, '\\.')));
    assert.doesNotMatch(page, /secret/, 'passwords must never be rendered');
  });

  test('read-only grant exposes only read tools; write grant exposes write tools', async () => {
    const readTokens = await authorize(browser, client, []);
    assert.equal(readTokens.scope, 'mail:read');
    const readClient = await mcpClient(readTokens.access_token);
    const readTools = (await readClient.listTools()).tools.map((t) => t.name);
    assert.ok(readTools.includes('list_messages'));
    assert.ok(!readTools.includes('move_messages'));
    await readClient.close();

    const writeTokens = await authorize(browser, client, ['mail:write', 'mail:send']);
    assert.equal(writeTokens.scope, 'mail:read mail:write mail:send');
    const writeClient = await mcpClient(writeTokens.access_token);
    const writeTools = (await writeClient.listTools()).tools.map((t) => t.name);
    assert.ok(writeTools.includes('move_messages') && writeTools.includes('send_email'));
    await writeClient.close();
  });

  test('works with a real mailbox', { skip: !imapHost && 'IMAP_TEST_HOST not set' }, async () => {
    const transport = nodemailer.createTransport({ host: imapHost, port: Number(smtpPort), secure: false, ignoreTLS: true });
    await transport.sendMail({ from: 'dave@example.com', to: mailUser, subject: 'Via HTTP', text: 'Hello over HTTPS stream' });
    transport.close();
    await new Promise((r) => setTimeout(r, 300));

    const tokens = await authorize(browser, client, ['mail:write']);
    const mcp = await mcpClient(tokens.access_token);
    const result = await mcp.callTool({ name: 'list_messages', arguments: {} });
    assert.ok(!result.isError, result.content[0].text);
    const list = JSON.parse(result.content[0].text);
    assert.equal(list.messages[0].subject, 'Via HTTP');
    const flagged = await mcp.callTool({ name: 'update_flags', arguments: { uids: [list.messages[0].uid], add: ['flagged'] } });
    assert.ok(!flagged.isError, flagged.content[0].text);
    await mcp.close();
  });

  test('refresh tokens rotate and revoking access invalidates tokens', async () => {
    const tokens = await authorize(browser, client, []);
    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    assert.equal(refreshed.status, 200);
    assert.notEqual(refreshed.body.access_token, tokens.access_token);
    const reuse = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    assert.equal(reuse.status, 400, 'used refresh token must be rejected');

    const html = await (await browser.request('/account')).text();
    const grantIds = [...html.matchAll(/\/account\/grants\/(\d+)\/revoke/g)].map((m) => m[1]);
    assert.ok(grantIds.length > 0);
    for (const id of grantIds) {
      const res = await browser.request(`/account/grants/${id}/revoke`, { method: 'POST', form: { csrf: browser.csrf() } });
      assert.equal(res.status, 303);
    }
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${refreshed.body.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 401);
  });

  test('denying consent redirects with access_denied', async () => {
    const { challenge } = pkce();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's1',
    });
    const res1 = await browser.request(`/authorize?${query}`);
    const requestId = new URL(res1.headers.get('location'), base).searchParams.get('request');
    const res = await browser.request('/oauth/consent', { method: 'POST', form: { csrf: browser.csrf(), request: requestId, action: 'deny' } });
    const location = new URL(res.headers.get('location'));
    assert.equal(location.searchParams.get('error'), 'access_denied');
    assert.equal(location.searchParams.get('state'), 's1');
  });
});
