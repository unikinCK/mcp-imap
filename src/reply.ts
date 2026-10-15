import type { MessageAddressObject, MessageEnvelopeObject } from 'imapflow';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import type { AccountConfig } from './config.js';
import { bodyOf, escapeHtml, type ForwardSource } from './forward.js';
import { formatAddress, htmlToPlain } from './messages.js';

export type QuoteLanguage = 'en' | 'de';

/** All addresses that belong to the account, so that "reply all" does not include ourselves. */
export function ownAddresses(account: AccountConfig): Set<string> {
  const own = new Set<string>();
  const add = (value?: string) => {
    if (!value) return;
    for (const entry of addressparser(value, { flatten: true })) {
      if (entry.address) own.add(entry.address.toLowerCase());
    }
  };
  add(account.imap.user);
  add(account.smtp?.user);
  add(account.smtp?.from);
  return own;
}

function isOwn(a: MessageAddressObject, own: Set<string>): boolean {
  return Boolean(a.address && own.has(a.address.toLowerCase()));
}

/**
 * Determines recipients like common mail clients: reply to Reply-To (or From); when replying to
 * our own message, reply to its original recipients; "reply all" adds To and Cc without ourselves.
 */
export function replyRecipients(env: MessageEnvelopeObject, own: Set<string>, replyAll: boolean): { to: string[]; cc: string[] } {
  const from = env.from ?? [];
  const fromSelf = from.length > 0 && from.every((a) => isOwn(a, own));
  const primary = fromSelf ? (env.to ?? []) : env.replyTo?.length ? env.replyTo : from;
  const seen = new Set<string>();
  const unique = (list: MessageAddressObject[]) =>
    list.filter((a) => {
      const key = (a.address ?? a.name ?? '').toLowerCase();
      if (!key || seen.has(key) || (!fromSelf && isOwn(a, own))) return false;
      seen.add(key);
      return true;
    });
  const to = unique(primary);
  const cc = replyAll ? unique([...(fromSelf ? [] : (env.to ?? [])), ...(env.cc ?? [])]).filter((a) => !isOwn(a, own)) : [];
  return { to: to.map(formatAddress), cc: cc.map(formatAddress) };
}

export function replySubject(subject: string | undefined): string {
  const original = (subject ?? '').trim();
  return /^(re|aw|antw):/i.test(original) ? original : `Re: ${original}`;
}

function quoteHeader(env: MessageEnvelopeObject, language: QuoteLanguage): string {
  const from = env.from?.length ? env.from.map(formatAddress).join(', ') : 'unknown';
  if (!env.date) return language === 'de' ? `${from} schrieb:` : `${from} wrote:`;
  const date = new Date(env.date);
  if (language === 'de') {
    const formatted = date.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });
    return `Am ${formatted} schrieb ${from}:`;
  }
  const formatted = date.toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' });
  return `On ${formatted} UTC, ${from} wrote:`;
}

/** Reply text above a quote of the original (">" in plain text, blockquote in HTML). */
export function replyBodies(
  text: string | undefined,
  html: string | undefined,
  source: ForwardSource,
  language: QuoteLanguage,
): { text: string; html?: string } {
  const header = quoteHeader(source.envelope, language);
  const originalText = (source.text ?? (source.html ? htmlToPlain(source.html) : '')).replace(/\s+$/, '');
  const quoted = originalText
    .split(/\r?\n/)
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
  const ownText = (text ?? (html ? htmlToPlain(html) : '')).replace(/\s+$/, '');
  const plain = `${ownText}\n\n${header}\n${quoted}\n`;

  if (!source.html && !html) return { text: plain };
  const ownHtml = html ?? `<div>${escapeHtml(ownText).replace(/\n/g, '<br>')}</div>`;
  const originalHtml = source.html ? bodyOf(source.html) : `<pre>${escapeHtml(originalText)}</pre>`;
  return {
    text: plain,
    html:
      `${ownHtml}<br><div>${escapeHtml(header)}</div>` +
      `<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${originalHtml}</blockquote>`,
  };
}
