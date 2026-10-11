import type { Grant, MailAccount, User } from './store.js';
import { SCOPE_DESCRIPTIONS, SCOPES } from './oauth.js';

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const STYLE = `
:root { --bg:#f6f7f9; --card:#fff; --text:#1d2330; --muted:#5f6b7a; --border:#dde1e7; --accent:#2f5bea; --accent-text:#fff; --danger:#c62828; --ok:#2e7d32; }
@media (prefers-color-scheme: dark) { :root { --bg:#14171c; --card:#1d2128; --text:#e6e9ee; --muted:#9aa4b2; --border:#2f3540; --accent:#6d8dff; --accent-text:#0d1020; --danger:#ef6b6b; --ok:#6fcf73; } }
* { box-sizing: border-box; }
a { color:var(--accent); }
body { margin:0; font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--bg); color:var(--text); }
header { display:flex; justify-content:space-between; align-items:center; padding:12px 16px; border-bottom:1px solid var(--border); background:var(--card); }
header .brand { font-weight:600; color:inherit; text-decoration:none; }
main { max-width:760px; margin:24px auto; padding:0 16px; }
.card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:20px; margin-bottom:20px; }
.narrow { max-width:420px; margin-left:auto; margin-right:auto; }
h1 { font-size:1.4rem; margin:0 0 12px; } h2 { font-size:1.1rem; margin:0 0 12px; }
label { display:block; margin:10px 0 4px; font-weight:500; }
input[type=text], input[type=password], input[type=number], input[type=email] { width:100%; padding:8px 10px; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--text); font:inherit; }
.check { display:flex; gap:8px; align-items:flex-start; margin:8px 0; font-weight:normal; }
.check input { margin-top:4px; }
.grid { display:grid; grid-template-columns:1fr 120px; gap:0 12px; }
button, .button { display:inline-block; padding:8px 16px; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:var(--accent-text); font:inherit; cursor:pointer; text-decoration:none; }
button.secondary, .button.secondary { background:transparent; color:var(--text); border-color:var(--border); }
.row-actions { text-align:right; white-space:nowrap; }
button.danger { background:transparent; color:var(--danger); border-color:var(--danger); }
.actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:16px; }
.inline { display:inline; }
.muted { color:var(--muted); font-size:.9rem; }
.error { color:var(--danger); border:1px solid var(--danger); border-radius:6px; padding:8px 12px; margin-bottom:12px; }
.notice { color:var(--ok); border:1px solid var(--ok); border-radius:6px; padding:8px 12px; margin-bottom:12px; }
table { width:100%; border-collapse:collapse; } td, th { text-align:left; padding:8px 4px; border-bottom:1px solid var(--border); vertical-align:top; }
code { background:var(--bg); padding:1px 4px; border-radius:4px; word-break:break-all; }
fieldset { border:1px solid var(--border); border-radius:8px; margin:16px 0 0; padding:4px 14px 14px; } legend { padding:0 6px; color:var(--muted); }
@media (max-width:520px) { .grid { grid-template-columns:1fr; } }
`;

interface PageOptions {
  title: string;
  user?: User;
  csrf: string;
  error?: string;
  notice?: string;
}

export function page(opts: PageOptions, body: string): string {
  const nav = opts.user
    ? `<div><span class="muted">${esc(opts.user.username)}</span>
       <form method="post" action="/logout" class="inline"><input type="hidden" name="csrf" value="${esc(opts.csrf)}">
       <button class="secondary" type="submit">Log out</button></form></div>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} · mcp-imap</title><link rel="stylesheet" href="/static/style.css"></head>
<body><header><a class="brand" href="/account">mcp-imap</a>${nav}</header>
<main>${opts.error ? `<div class="error">${esc(opts.error)}</div>` : ''}${
    opts.notice ? `<div class="notice">${esc(opts.notice)}</div>` : ''
  }${body}</main></body></html>`;
}

function signInContext(host: string, clientName?: string): string {
  return `<p>Server <code>${esc(host)}</code></p>${
    clientName ? `<p>Sign in to connect <strong>${esc(clientName)}</strong> to your mailboxes.</p>` : ''
  }<p class="muted">Use your mcp-imap account (created by the server administrator), not the password of your email account.</p>`;
}

export function loginPage(
  opts: PageOptions & { next: string; username?: string; allowRegistration: boolean; host: string; clientName?: string },
): string {
  return page(
    opts,
    `<div class="card narrow"><h1>Sign in to mcp-imap</h1>${signInContext(opts.host, opts.clientName)}
<form method="post" action="/login">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}"><input type="hidden" name="next" value="${esc(opts.next)}">
<label for="username">Username</label><input id="username" type="text" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus value="${esc(opts.username)}">
<label for="password">Password</label><input id="password" type="password" name="password" autocomplete="current-password" required>
<div class="actions"><button type="submit">Sign in</button></div></form>
${
  opts.allowRegistration
    ? `<p class="muted">No account yet? <a href="/register?next=${encodeURIComponent(opts.next)}">Create one</a>.</p>`
    : ''
}</div>`,
  );
}

export function registerPage(opts: PageOptions & { next: string; username?: string; host: string; clientName?: string }): string {
  return page(
    opts,
    `<div class="card narrow"><h1>Create an mcp-imap account</h1>${signInContext(opts.host, opts.clientName)}
<form method="post" action="/register">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}"><input type="hidden" name="next" value="${esc(opts.next)}">
<label for="username">Username</label><input id="username" type="text" name="username" autocomplete="username" required value="${esc(opts.username)}">
<label for="password">Password (min. 10 characters)</label><input id="password" type="password" name="password" autocomplete="new-password" minlength="10" required>
<label for="password2">Repeat password</label><input id="password2" type="password" name="password2" autocomplete="new-password" minlength="10" required>
<div class="actions"><button type="submit">Create account</button></div></form>
<p class="muted">Already registered? <a href="/login?next=${encodeURIComponent(opts.next)}">Sign in</a>.</p></div>`,
  );
}

export function consentPage(
  opts: PageOptions & {
    requestId: string;
    clientName: string;
    redirectHost: string;
    requested: string[];
    available: string[];
    accountCount: number;
  },
): string {
  const checks = opts.available
    .map((scope) => {
      const required = scope === SCOPES.read;
      const checked = required || opts.requested.includes(scope);
      return `<label class="check"><input type="checkbox" name="scope" value="${esc(scope)}"${checked ? ' checked' : ''}${
        required ? ' disabled' : ''
      }><span><strong>${esc(SCOPE_DESCRIPTIONS[scope] ?? scope)}</strong><br><span class="muted">${esc(scope)}</span></span></label>`;
    })
    .join('');
  return page(
    opts,
    `<div class="card narrow"><h1>Authorize access</h1>
<p><strong>${esc(opts.clientName)}</strong> wants to access your mailboxes.</p>
<p class="muted">After approval you will be redirected to <code>${esc(opts.redirectHost)}</code>.</p>
${
  opts.accountCount === 0
    ? `<div class="error">You have not added a mail account yet. <a href="/account">Add one</a> first, or approve now and add it later.</div>`
    : ''
}
<form method="post" action="/oauth/consent">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}"><input type="hidden" name="request" value="${esc(opts.requestId)}">
<input type="hidden" name="scope" value="${SCOPES.read}">
<fieldset><legend>Permissions</legend>${checks}</fieldset>
<div class="actions"><button type="submit" name="action" value="approve">Allow</button>
<button class="secondary" type="submit" name="action" value="deny">Deny</button></div></form></div>`,
  );
}

function accountForm(csrf: string, account?: MailAccount): string {
  const s = account?.settings;
  const action = account ? `/account/mail/${account.id}` : '/account/mail';
  const v = (value: unknown) => esc(value ?? '');
  const checked = (value: boolean | undefined, fallback: boolean) => ((value ?? fallback) ? ' checked' : '');
  return `<form method="post" action="${action}">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<label>Account name</label><input type="text" name="name" required pattern="[A-Za-z0-9._-]{1,50}" value="${v(account?.name ?? (account ? '' : 'default'))}">
<span class="muted">Letters, digits, dot, dash, underscore. Used as <code>account</code> argument in tools.</span>
<fieldset><legend>IMAP</legend>
<div class="grid"><div><label>Host</label><input type="text" name="imap_host" required value="${v(s?.imap.host)}"></div>
<div><label>Port</label><input type="number" name="imap_port" min="1" max="65535" value="${v(s?.imap.port ?? 993)}"></div></div>
<label class="check"><input type="checkbox" name="imap_secure" value="1"${checked(s?.imap.secure, true)}> Use TLS (port 993). Without it, STARTTLS is used when offered.</label>
<label>Username</label><input type="text" name="imap_user" required autocomplete="off" value="${v(s?.imap.user)}">
<label>Password${account ? ' <span class="muted">(leave empty to keep)</span>' : ''}</label><input type="password" name="imap_password" autocomplete="new-password"${account ? '' : ' required'}>
<label class="check"><input type="checkbox" name="imap_tls_insecure" value="1"${checked(s ? !s.imap.tlsRejectUnauthorized : false, false)}> Accept self-signed certificates</label>
</fieldset>
<fieldset><legend>SMTP (optional, for sending)</legend>
<div class="grid"><div><label>Host</label><input type="text" name="smtp_host" value="${v(s?.smtp?.host)}"></div>
<div><label>Port</label><input type="number" name="smtp_port" min="1" max="65535" value="${v(s?.smtp?.port ?? 465)}"></div></div>
<label class="check"><input type="checkbox" name="smtp_secure" value="1"${checked(s?.smtp?.secure, true)}> Use TLS (port 465). Without it, STARTTLS is used (port 587).</label>
<label>Username <span class="muted">(empty = IMAP username)</span></label><input type="text" name="smtp_user" autocomplete="off" value="${v(
    s?.smtp && s.smtp.user !== s.imap.user ? s.smtp.user : '',
  )}">
<label>Password <span class="muted">(empty = ${account ? 'keep / ' : ''}IMAP password)</span></label><input type="password" name="smtp_password" autocomplete="new-password">
<label>From address</label><input type="text" name="smtp_from" placeholder="Jane Doe &lt;jane@example.com&gt;" value="${v(s?.smtp?.from)}">
<label class="check"><input type="checkbox" name="smtp_save_to_sent" value="1"${checked(s?.smtp?.saveToSent, true)}> Save sent messages to the Sent folder (disable for Gmail)</label>
</fieldset>
<label class="check"><input type="checkbox" name="read_only" value="1"${checked(s?.readOnly, false)}> Always read-only (no changes, no sending, regardless of granted permissions)</label>
<div class="actions"><button type="submit">${account ? 'Save' : 'Add account'}</button>${
    account ? '<a class="button secondary" href="/account">Cancel</a>' : ''
  }</div></form>`;
}

export function accountPage(
  opts: PageOptions & { accounts: MailAccount[]; grants: (Grant & { client_name?: string })[]; mcpUrl: string; mode: string },
): string {
  const csrf = esc(opts.csrf);
  const accounts = opts.accounts.length
    ? `<table><tr><th>Name</th><th>Login</th><th></th></tr>${opts.accounts
        .map(
          (a) => `<tr><td><strong>${esc(a.name)}</strong>${a.settings.readOnly ? ' <span class="muted">(read-only)</span>' : ''}</td>
<td>${esc(a.settings.imap.user)}<br><span class="muted">${esc(a.settings.imap.host)}${a.settings.smtp ? ' · SMTP ' + esc(a.settings.smtp.host) : ''}</span></td>
<td class="row-actions">
<form method="post" action="/account/mail/${a.id}/test" class="inline"><input type="hidden" name="csrf" value="${csrf}"><button class="secondary" type="submit">Test</button></form>
<a class="button secondary" href="/account/mail/${a.id}">Edit</a>
<form method="post" action="/account/mail/${a.id}/delete" class="inline"><input type="hidden" name="csrf" value="${csrf}"><button class="danger" type="submit">Delete</button></form>
</td></tr>`,
        )
        .join('')}</table>`
    : '<p class="muted">No mail accounts yet.</p>';

  const grants = opts.grants.length
    ? `<table><tr><th>Application</th><th>Permissions</th><th></th></tr>${opts.grants
        .map(
          (g) => `<tr><td>${esc(g.client_name || g.client_id)}<br><span class="muted">since ${esc(
            new Date(g.created_at * 1000).toISOString().slice(0, 10),
          )}${g.last_used_at ? ', last refresh ' + esc(new Date(g.last_used_at * 1000).toISOString().slice(0, 10)) : ''}</span></td>
<td>${g.scopes.map((s) => `<code>${esc(s)}</code>`).join(' ')}</td>
<td class="row-actions"><form method="post" action="/account/grants/${g.id}/revoke" class="inline"><input type="hidden" name="csrf" value="${csrf}"><button class="danger" type="submit">Revoke</button></form></td></tr>`,
        )
        .join('')}</table>`
    : '<p class="muted">No applications connected.</p>';

  return page(
    opts,
    `<div class="card"><h1>Your MCP server</h1>
<p>Add this URL as a remote MCP server / custom connector in Claude or another MCP client:</p>
<p><code>${esc(opts.mcpUrl)}</code></p>
<p class="muted">Server mode: <strong>${esc(opts.mode)}</strong>. You choose the permissions for each application when you connect it.</p></div>
<div class="card"><h2>Mail accounts</h2>${accounts}</div>
<div class="card"><h2>Add mail account</h2>${accountForm(opts.csrf)}</div>
<div class="card"><h2>Connected applications</h2>${grants}</div>
<div class="card"><h2>Change password</h2>
<form method="post" action="/account/password"><input type="hidden" name="csrf" value="${csrf}">
<label>Current password</label><input type="password" name="current" autocomplete="current-password" required>
<label>New password (min. 10 characters)</label><input type="password" name="password" autocomplete="new-password" minlength="10" required>
<div class="actions"><button type="submit">Change password</button></div></form></div>`,
  );
}

export function editAccountPage(opts: PageOptions & { account: MailAccount }): string {
  return page(opts, `<div class="card"><h1>Edit ${esc(opts.account.name)}</h1>${accountForm(opts.csrf, opts.account)}</div>`);
}

export function messagePage(opts: PageOptions & { heading: string; text: string }): string {
  return page(opts, `<div class="card narrow"><h1>${esc(opts.heading)}</h1><p>${esc(opts.text)}</p></div>`);
}
