import { createHash, createHmac } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import cors from 'cors';
import express, { type Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { AttachmentLinker, AttachmentRef } from '../attachments.js';
import { uidValidityOf } from '../attachments.js';
import { AuditLog } from '../audit.js';
import { levelAllows } from '../config.js';
import { AccountManager, type ConnectionPool } from '../imap.js';
import type { HttpConfig } from './config.js';
import { safeEqual } from './crypto.js';
import type { Store } from './store.js';

/**
 * Download links are capability URLs: the signed token is the only credential, so programs and
 * code sandboxes without the OAuth token can fetch the file. They are bound to one user and one
 * body part, expire after a few minutes and stop working when the mailbox changes UIDVALIDITY.
 */
interface TokenPayload {
  v: 1;
  /** user id */
  u: number;
  /** account name */
  a: string;
  /** mailbox */
  m: string;
  uid: number;
  p: string;
  /** UIDVALIDITY */
  uv: string;
  /** expiry, unix seconds */
  e: number;
}

function key(secret: string): Buffer {
  return createHash('sha256').update(`mcp-imap:download:${secret}`).digest();
}

function sign(payload: TokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', key(secret)).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyDownloadToken(token: string, secret: string, now = Date.now()): TokenPayload | undefined {
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return undefined;
  const expected = createHmac('sha256', key(secret)).update(body).digest('base64url');
  if (!safeEqual(mac, expected)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    if (payload.v !== 1 || typeof payload.e !== 'number' || payload.e * 1000 < now) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

/** Link factory for one user; passed to the MCP server created for that user's request. */
export function downloadLinker(config: HttpConfig, userId: number): AttachmentLinker | undefined {
  if (!config.downloadLinks) return undefined;
  return (ref: AttachmentRef) => {
    const expires = Math.floor(Date.now() / 1000) + config.downloadTtl;
    const token = sign({ v: 1, u: userId, a: ref.account, m: ref.mailbox, uid: ref.uid, p: ref.part, uv: ref.uidValidity, e: expires }, config.secretKey);
    const name = ref.filename ? `/${encodeURIComponent(ref.filename.replace(/[/\\]/g, '_'))}` : '';
    return { url: new URL(`/attachments/${token}${name}`, config.publicUrl).href, expiresAt: new Date(expires * 1000).toISOString() };
  };
}

function contentDisposition(filename: string | undefined): string {
  if (!filename) return 'attachment';
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function downloadRouter(options: {
  config: HttpConfig;
  store: Store;
  poolFor: (userId: number) => ConnectionPool;
}): Router {
  const { config, store, poolFor } = options;
  const router = express.Router();
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });

  // The optional trailing file name only makes the URL readable; it is not trusted.
  router.get(['/attachments/:token', '/attachments/:token/:name'], cors({ origin: true }), limiter, async (req, res) => {
    const payload = verifyDownloadToken(String(req.params.token), config.secretKey);
    const notFound = () => res.status(404).type('text/plain').send('Link expired or invalid. Request a new one with get_attachment.\n');
    if (!payload || !store.getUser(payload.u)) return notFound();
    const accounts = store.accountConfigs(payload.u);
    const account = accounts.find((a) => a.name === payload.a);
    if (!account) return notFound();
    const manager = new AccountManager(
      {
        mode: config.mode,
        allowSend: false,
        allowDelete: false,
        accounts,
        maxBodyChars: config.maxBodyChars,
        maxAttachmentBytes: config.maxAttachmentBytes,
        extract: config.extract,
      },
      poolFor(payload.u),
    );
    try {
      await manager.withMailbox(account.name, payload.m, false, async (client) => {
        if (uidValidityOf(client) !== payload.uv) return notFound();
        const download = await client.download(String(payload.uid), payload.p, { uid: true });
        if (!('content' in download) || !download.content) return notFound();
        const filename = download.meta.filename;
        res.status(200).set({
          'Content-Type': download.meta.contentType || 'application/octet-stream',
          'Content-Disposition': contentDisposition(filename),
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          // Attachments are untrusted: never let an HTML file run scripts on this origin.
          'Content-Security-Policy': "sandbox; default-src 'none'",
          'Referrer-Policy': 'no-referrer',
        });
        await pipeline(download.content, res);
        const user = store.getUser(payload.u);
        process.stderr.write(
          `[mcp-imap] download: user ${user?.username ?? payload.u}, account ${account.name}, ${payload.m} UID ${payload.uid} part ${payload.p}` +
            ` (${filename ?? 'unnamed'}) from ${req.ip}\n`,
        );
        if (config.mode === 'read-write' && levelAllows(account.access, 'write')) {
          const audit = new AuditLog(config.logFolder, `download link (mcp-imap user ${user?.username ?? payload.u}, ${req.ip})`);
          await audit.write(client, account, {
            action: 'download_attachment',
            summary: `Downloaded attachment ${filename ?? `part ${payload.p}`} via download link`,
            mailbox: payload.m,
            messages: [{ uid: payload.uid }],
            details: { part: payload.p, filename, userAgent: req.get('user-agent') },
          });
        }
      });
    } catch (err) {
      process.stderr.write(`[mcp-imap] download error: ${(err as Error).message}\n`);
      if (!res.headersSent) res.status(502).type('text/plain').send('Could not fetch the attachment from the mail server.\n');
      else res.destroy();
    }
  });
  return router;
}
