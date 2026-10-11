import express, { type Request, type Response, type Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import type { HttpConfig } from './config.js';
import { randomToken, safeEqual } from './crypto.js';
import { SCOPES, supportedScopes } from './oauth.js';
import type { MailAccountSettings, Store, User } from './store.js';
import {
  accountPage,
  consentPage,
  editAccountPage,
  loginPage,
  messagePage,
  registerPage,
  STYLE,
} from './views.js';

interface WebOptions {
  store: Store;
  config: HttpConfig;
  /** Called whenever the mail accounts or grants of a user change. */
  onUserChanged: (userId: number) => void;
}

const SESSION_TTL = 7 * 24 * 3600;

function parseCookies(req: Request): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    try {
      result[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      // ignore malformed cookies
    }
  }
  return result;
}

/** Only allow local redirects after login, never to other hosts. */
function safeNext(value: unknown): string {
  const next = typeof value === 'string' ? value : '';
  return next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/account';
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return typeof value === 'string' ? [value] : [];
}

function parsePort(value: unknown, fallback: number): number {
  const n = Number.parseInt(str(value), 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

/** Builds account settings from the form. Empty password fields keep the previous values. */
function settingsFromForm(body: Record<string, unknown>, previous?: MailAccountSettings): { name: string; settings: MailAccountSettings } {
  const name = str(body.name);
  if (!/^[A-Za-z0-9._-]{1,50}$/.test(name)) throw new Error('Invalid account name.');
  const imapSecure = body.imap_secure === '1';
  const imapPassword = typeof body.imap_password === 'string' && body.imap_password ? body.imap_password : previous?.imap.password;
  const imap = {
    host: str(body.imap_host),
    port: parsePort(body.imap_port, imapSecure ? 993 : 143),
    secure: imapSecure,
    user: str(body.imap_user),
    password: imapPassword ?? '',
    tlsRejectUnauthorized: body.imap_tls_insecure !== '1',
  };
  if (!imap.host || !imap.user || !imap.password) throw new Error('IMAP host, username and password are required.');

  let smtp: MailAccountSettings['smtp'];
  const smtpHost = str(body.smtp_host);
  if (smtpHost) {
    const smtpSecure = body.smtp_secure === '1';
    const smtpUser = str(body.smtp_user) || imap.user;
    const newPassword = typeof body.smtp_password === 'string' ? body.smtp_password : '';
    // Keep a previously stored separate SMTP password, otherwise fall back to the IMAP password.
    const prevSmtpPassword = previous?.smtp && previous.smtp.password !== previous.imap.password ? previous.smtp.password : undefined;
    smtp = {
      host: smtpHost,
      port: parsePort(body.smtp_port, smtpSecure ? 465 : 587),
      secure: smtpSecure,
      user: smtpUser,
      password: newPassword || prevSmtpPassword || imap.password,
      from: str(body.smtp_from) || smtpUser,
      tlsRejectUnauthorized: imap.tlsRejectUnauthorized,
      saveToSent: body.smtp_save_to_sent === '1',
    };
  }
  return { name, settings: { imap, smtp, readOnly: body.read_only === '1' } };
}

async function testAccount(settings: MailAccountSettings): Promise<string> {
  const { imap } = settings;
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.secure,
    auth: { user: imap.user, pass: imap.password },
    tls: { rejectUnauthorized: imap.tlsRejectUnauthorized },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  });
  client.on('error', () => undefined);
  await client.connect();
  const boxes = await client.list();
  await client.logout();
  let result = `IMAP login successful (${boxes.length} mailboxes).`;
  if (settings.smtp) {
    const smtp = settings.smtp;
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.password ?? '' } : undefined,
      tls: { rejectUnauthorized: smtp.tlsRejectUnauthorized },
      connectionTimeout: 15_000,
    });
    try {
      await transport.verify();
      result += ' SMTP login successful.';
    } finally {
      transport.close();
    }
  }
  return result;
}

export function webRouter({ store, config, onUserChanged }: WebOptions): Router {
  const router = express.Router();
  const secure = config.publicUrl.protocol === 'https:';
  // __Host- cookies are bound to this exact origin; they require the Secure attribute.
  const SESSION_COOKIE = secure ? '__Host-mcpimap_session' : 'mcpimap_session';
  const CSRF_COOKIE = secure ? '__Host-mcpimap_csrf' : 'mcpimap_csrf';
  const mcpUrl = new URL('/mcp', config.publicUrl).href;

  router.use(express.urlencoded({ extended: false, limit: '100kb' }));
  router.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    next();
  });

  const setCookie = (res: Response, name: string, value: string, maxAge: number) => {
    res.cookie(name, value, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: maxAge * 1000 });
  };

  /** Double-submit CSRF token: the cookie value must be echoed in each form. */
  const csrfToken = (req: Request, res: Response): string => {
    let token = parseCookies(req)[CSRF_COOKIE];
    if (!token || token.length < 20) {
      token = randomToken(24);
      setCookie(res, CSRF_COOKIE, token, SESSION_TTL);
    }
    return token;
  };
  const checkCsrf = (req: Request): boolean => {
    const cookie = parseCookies(req)[CSRF_COOKIE];
    const sent = typeof req.body?.csrf === 'string' ? req.body.csrf : '';
    return Boolean(cookie && sent && safeEqual(cookie, sent));
  };
  const currentUser = (req: Request): User | undefined => {
    const sid = parseCookies(req)[SESSION_COOKIE];
    return sid ? store.sessionUser(sid) : undefined;
  };

  const render = (res: Response, html: string, status = 200) => res.status(status).type('html').send(html);

  const forbidden = (req: Request, res: Response) =>
    render(res, messagePage({ title: 'Error', csrf: csrfToken(req, res), heading: 'Request rejected', text: 'Invalid or missing form token. Please go back, reload the page and try again.' }), 403);

  /** Route wrapper that requires a logged-in user (and a valid CSRF token for POST). */
  const authed =
    (fn: (req: Request, res: Response, user: User) => unknown) => async (req: Request, res: Response) => {
      const user = currentUser(req);
      if (!user) return res.redirect(303, `/login?next=${encodeURIComponent(req.method === 'GET' ? req.originalUrl : '/account')}`);
      if (req.method === 'POST' && !checkCsrf(req)) return forbidden(req, res);
      try {
        await fn(req, res, user);
      } catch (err) {
        render(res, messagePage({ title: 'Error', user, csrf: csrfToken(req, res), heading: 'Something went wrong', text: (err as Error).message }), 400);
      }
    };

  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });

  router.get('/static/style.css', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600').type('css').send(STYLE);
  });

  router.get('/', (_req, res) => res.redirect(302, '/account'));

  // ---- login / logout / registration ----------------------------------------------------------

  router.get('/login', (req, res) => {
    const next = safeNext(req.query.next);
    if (currentUser(req)) return res.redirect(303, next);
    render(res, loginPage({ title: 'Sign in', csrf: csrfToken(req, res), next, allowRegistration: config.allowRegistration }));
  });

  router.post('/login', loginLimiter, async (req, res) => {
    const next = safeNext(req.body?.next);
    if (!checkCsrf(req)) return forbidden(req, res);
    const username = str(req.body?.username);
    const user = await store.authenticate(username, typeof req.body?.password === 'string' ? req.body.password : '');
    if (!user) {
      return render(
        res,
        loginPage({ title: 'Sign in', csrf: csrfToken(req, res), next, username, allowRegistration: config.allowRegistration, error: 'Invalid username or password.' }),
        401,
      );
    }
    const old = parseCookies(req)[SESSION_COOKIE];
    if (old) store.deleteSession(old);
    setCookie(res, SESSION_COOKIE, store.createSession(user.id, SESSION_TTL), SESSION_TTL);
    res.redirect(303, next);
  });

  router.post('/logout', (req, res) => {
    if (!checkCsrf(req)) return forbidden(req, res);
    const sid = parseCookies(req)[SESSION_COOKIE];
    if (sid) store.deleteSession(sid);
    res.clearCookie(SESSION_COOKIE, { path: '/', secure, httpOnly: true, sameSite: 'lax' });
    res.redirect(303, '/login');
  });

  router.get('/register', (req, res) => {
    if (!config.allowRegistration) return res.redirect(303, '/login');
    render(res, registerPage({ title: 'Create account', csrf: csrfToken(req, res), next: safeNext(req.query.next) }));
  });

  router.post('/register', loginLimiter, async (req, res) => {
    if (!config.allowRegistration) return res.redirect(303, '/login');
    if (!checkCsrf(req)) return forbidden(req, res);
    const next = safeNext(req.body?.next);
    const username = str(req.body?.username);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    try {
      if (password !== req.body?.password2) throw new Error('Passwords do not match.');
      const user = await store.createUser(username, password);
      setCookie(res, SESSION_COOKIE, store.createSession(user.id, SESSION_TTL), SESSION_TTL);
      res.redirect(303, next);
    } catch (err) {
      render(res, registerPage({ title: 'Create account', csrf: csrfToken(req, res), next, username, error: (err as Error).message }), 400);
    }
  });

  // ---- OAuth consent --------------------------------------------------------------------------

  router.get('/oauth/consent', (req, res) => {
    const requestId = str(req.query.request);
    const request = store.getAuthRequest(requestId);
    if (!request) {
      return render(res, messagePage({ title: 'Expired', csrf: csrfToken(req, res), heading: 'Authorization request expired', text: 'Please start the connection from your MCP client again.' }), 400);
    }
    const user = currentUser(req);
    if (!user) return res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
    const client = store.getClient(request.clientId);
    render(
      res,
      consentPage({
        title: 'Authorize',
        user,
        csrf: csrfToken(req, res),
        requestId,
        clientName: client?.client_name || request.clientId,
        redirectHost: new URL(request.redirectUri).host || request.redirectUri,
        requested: request.scopes,
        available: supportedScopes(config),
        accountCount: store.listMailAccounts(user.id).length,
      }),
    );
  });

  router.post(
    '/oauth/consent',
    authed((req, res, user) => {
      const requestId = str(req.body?.request);
      const request = store.getAuthRequest(requestId);
      if (!request) throw new Error('Authorization request expired. Please start again from your MCP client.');
      store.deleteAuthRequest(requestId);

      const target = new URL(request.redirectUri);
      if (request.state !== undefined) target.searchParams.set('state', request.state);
      if (req.body?.action !== 'approve') {
        target.searchParams.set('error', 'access_denied');
        target.searchParams.set('error_description', 'The user denied the request');
        return res.redirect(303, target.href);
      }
      const available = supportedScopes(config);
      const scopes = [...new Set([SCOPES.read, ...list(req.body?.scope)])].filter((s) => available.includes(s));
      // Sending only makes sense together with write access.
      if (scopes.includes(SCOPES.send) && !scopes.includes(SCOPES.write)) scopes.push(SCOPES.write);
      const code = store.createAuthCode({ ...request, scopes, userId: user.id });
      target.searchParams.set('code', code);
      res.redirect(303, target.href);
    }),
  );

  // ---- account management ---------------------------------------------------------------------

  const showAccount = (req: Request, res: Response, user: User, extra: { error?: string; notice?: string } = {}, status = 200) =>
    render(
      res,
      accountPage({
        title: 'Account',
        user,
        csrf: csrfToken(req, res),
        accounts: store.listMailAccounts(user.id),
        grants: store.listGrants(user.id),
        mcpUrl,
        mode: config.mode,
        ...extra,
      }),
      status,
    );

  router.get(
    '/account',
    authed((req, res, user) => {
      const notice = typeof req.query.notice === 'string' ? req.query.notice.slice(0, 300) : undefined;
      showAccount(req, res, user, { notice });
    }),
  );

  router.post(
    '/account/mail',
    authed((req, res, user) => {
      try {
        const { name, settings } = settingsFromForm(req.body ?? {});
        store.saveMailAccount(user.id, undefined, name, settings);
        onUserChanged(user.id);
        res.redirect(303, `/account?notice=${encodeURIComponent(`Account "${name}" added.`)}`);
      } catch (err) {
        showAccount(req, res, user, { error: (err as Error).message }, 400);
      }
    }),
  );

  router.get(
    '/account/mail/:id',
    authed((req, res, user) => {
      const account = store.getMailAccount(user.id, Number(req.params.id));
      if (!account) return res.redirect(303, '/account');
      render(res, editAccountPage({ title: 'Edit account', user, csrf: csrfToken(req, res), account }));
    }),
  );

  router.post(
    '/account/mail/:id',
    authed((req, res, user) => {
      const account = store.getMailAccount(user.id, Number(req.params.id));
      if (!account) return res.redirect(303, '/account');
      try {
        const { name, settings } = settingsFromForm(req.body ?? {}, account.settings);
        store.saveMailAccount(user.id, account.id, name, settings);
        onUserChanged(user.id);
        res.redirect(303, `/account?notice=${encodeURIComponent(`Account "${name}" saved.`)}`);
      } catch (err) {
        render(res, editAccountPage({ title: 'Edit account', user, csrf: csrfToken(req, res), account, error: (err as Error).message }), 400);
      }
    }),
  );

  router.post(
    '/account/mail/:id/delete',
    authed((req, res, user) => {
      store.deleteMailAccount(user.id, Number(req.params.id));
      onUserChanged(user.id);
      res.redirect(303, `/account?notice=${encodeURIComponent('Account deleted.')}`);
    }),
  );

  router.post(
    '/account/mail/:id/test',
    authed(async (req, res, user) => {
      const account = store.getMailAccount(user.id, Number(req.params.id));
      if (!account) return res.redirect(303, '/account');
      try {
        const result = await testAccount(account.settings);
        showAccount(req, res, user, { notice: `${account.name}: ${result}` });
      } catch (err) {
        const e = err as { message?: string; responseText?: string };
        showAccount(req, res, user, { error: `${account.name}: connection failed – ${e.responseText || e.message}` }, 400);
      }
    }),
  );

  router.post(
    '/account/grants/:id/revoke',
    authed((req, res, user) => {
      store.deleteGrant(user.id, Number(req.params.id));
      onUserChanged(user.id);
      res.redirect(303, `/account?notice=${encodeURIComponent('Access revoked.')}`);
    }),
  );

  router.post(
    '/account/password',
    authed(async (req, res, user) => {
      const current = typeof req.body?.current === 'string' ? req.body.current : '';
      if (!(await store.authenticate(user.username, current))) {
        return showAccount(req, res, user, { error: 'Current password is wrong.' }, 400);
      }
      try {
        await store.setPassword(user.id, typeof req.body?.password === 'string' ? req.body.password : '');
      } catch (err) {
        return showAccount(req, res, user, { error: (err as Error).message }, 400);
      }
      store.deleteSessionsOfUser(user.id, parseCookies(req)[SESSION_COOKIE]);
      res.redirect(303, `/account?notice=${encodeURIComponent('Password changed. Other sessions were signed out.')}`);
    }),
  );

  return router;
}
