import type { ImapFlow, MessageEnvelopeObject } from 'imapflow';
import type Mail from 'nodemailer/lib/mailer/index.js';
import { ToolError } from './imap.js';
import { analyzeStructure, downloadPart, formatAddresses, htmlToPlain, parseHeaders } from './messages.js';

/** Upper limit for everything copied from existing messages into one draft. */
export const MAX_FORWARD_BYTES = 25 * 1024 * 1024;

/** Tracks how many bytes may still be copied into the draft being built. */
export class ByteBudget {
  constructor(public remaining = MAX_FORWARD_BYTES) {}

  take(bytes: number): void {
    if (bytes > this.remaining) {
      throw new ToolError(`Attachments exceed the limit of ${MAX_FORWARD_BYTES / 1024 / 1024} MB per draft.`);
    }
    this.remaining -= bytes;
  }
}

export interface AttachmentRef {
  mailbox: string;
  uid: number;
  /** Body part id from get_message; without it all attachments of the message are used. */
  part?: string;
}

export interface ForwardSource {
  mailbox: string;
  uid: number;
  envelope: MessageEnvelopeObject;
  messageId?: string;
  references?: string;
  text?: string;
  html?: string;
  attachments: Mail.Attachment[];
  /** Complete original message, when forwarding as attachment. */
  raw?: Buffer;
}

async function downloadAttachment(
  client: ImapFlow,
  uid: number,
  part: string,
  budget: ByteBudget,
  info: { filename?: string; contentId?: string; disposition?: string; contentType?: string },
): Promise<Mail.Attachment> {
  const { meta, data, truncated } = await downloadPart(client, uid, part, budget.remaining + 1);
  if (truncated) budget.take(budget.remaining + 1);
  budget.take(data.length);
  const type = meta.contentType || info.contentType || 'application/octet-stream';
  const contentType = meta.charset && type.startsWith('text/') ? `${type}; charset=${meta.charset}` : type;
  const cid = info.contentId?.replace(/^<|>$/g, '');
  return {
    filename: meta.filename || info.filename || (cid ? undefined : `attachment-${part}`),
    content: data,
    contentType,
    ...(cid ? { cid } : {}),
    contentDisposition: info.disposition === 'inline' && cid ? 'inline' : 'attachment',
  };
}

/** Loads attachments referenced by mailbox/uid/part, entirely server-side. */
export async function loadAttachmentRefs(client: ImapFlow, refs: AttachmentRef[], budget: ByteBudget): Promise<Mail.Attachment[]> {
  const result: Mail.Attachment[] = [];
  for (const ref of refs) {
    const lock = await client.getMailboxLock(ref.mailbox, { readOnly: true });
    try {
      const msg = await client.fetchOne(String(ref.uid), { uid: true, bodyStructure: true }, { uid: true });
      if (!msg) throw new ToolError(`Message UID ${ref.uid} not found in "${ref.mailbox}".`);
      const { attachments } = analyzeStructure(msg.bodyStructure);
      const selected = ref.part ? attachments.filter((a) => a.part === ref.part) : attachments;
      if (!selected.length) {
        throw new ToolError(
          ref.part
            ? `Message UID ${ref.uid} in "${ref.mailbox}" has no attachment with part "${ref.part}".`
            : `Message UID ${ref.uid} in "${ref.mailbox}" has no attachments.`,
        );
      }
      for (const a of selected) {
        // Inline images of a referenced message would be useless without its HTML, attach them as files.
        result.push(await downloadAttachment(client, ref.uid, a.part, budget, { ...a, disposition: 'attachment', contentId: undefined }));
      }
    } finally {
      lock.release();
    }
  }
  return result;
}

/** Loads a message for forwarding: decoded bodies and all attachments, or the complete raw message. */
export async function loadForwardSource(
  client: ImapFlow,
  mailbox: string,
  uid: number,
  asAttachment: boolean,
  budget: ByteBudget,
): Promise<ForwardSource> {
  const lock = await client.getMailboxLock(mailbox, { readOnly: true });
  try {
    const msg = await client.fetchOne(
      String(uid),
      { uid: true, envelope: true, bodyStructure: true, size: true, headers: ['references'] },
      { uid: true },
    );
    if (!msg) throw new ToolError(`Message UID ${uid} not found in "${mailbox}".`);
    const envelope = msg.envelope ?? {};
    const base = {
      mailbox,
      uid,
      envelope,
      messageId: envelope.messageId,
      references: parseHeaders(msg.headers)['references']?.join(' '),
    };
    if (asAttachment) {
      budget.take(msg.size ?? 0);
      const full = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
      if (!full || !full.source) throw new ToolError(`Could not load message UID ${uid}.`);
      return { ...base, attachments: [], raw: full.source };
    }
    const structure = analyzeStructure(msg.bodyStructure);
    const text = structure.text ? (await downloadPart(client, uid, structure.text.part!)).data.toString('utf8') : undefined;
    const html = structure.html ? (await downloadPart(client, uid, structure.html.part!)).data.toString('utf8') : undefined;
    const attachments: Mail.Attachment[] = [];
    for (const a of structure.attachments) {
      attachments.push(await downloadAttachment(client, uid, a.part, budget, a));
    }
    return { ...base, text, html, attachments };
  } finally {
    lock.release();
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function headerLines(env: MessageEnvelopeObject): [string, string][] {
  const lines: [string, string][] = [];
  const from = formatAddresses(env.from);
  if (from) lines.push(['From', from.join(', ')]);
  if (env.date) lines.push(['Date', new Date(env.date).toUTCString()]);
  lines.push(['Subject', env.subject ?? '']);
  const to = formatAddresses(env.to);
  if (to) lines.push(['To', to.join(', ')]);
  const cc = formatAddresses(env.cc);
  if (cc) lines.push(['Cc', cc.join(', ')]);
  return lines;
}

const SEPARATOR = '---------- Forwarded message ----------';

/** Extracts the inner part of <body> so that the original HTML can be embedded. */
function bodyOf(html: string): string {
  return /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
}

export function forwardSubject(sources: ForwardSource[]): string {
  const first = sources[0]?.envelope.subject ?? '';
  const base = /^(fwd?|wg):/i.test(first) ? first : `Fwd: ${first}`;
  return sources.length > 1 ? `${base} (+${sources.length - 1} more)` : base;
}

/** Builds the text and HTML bodies of a forward: the note followed by each original message. */
export function forwardBodies(note: string | undefined, sources: ForwardSource[]): { text: string; html?: string } {
  const textBlocks = sources.map((s) => {
    const header = headerLines(s.envelope).map(([k, v]) => `${k}: ${v}`).join('\n');
    if (s.raw) return `${SEPARATOR}\n${header}\n(attached as .eml)`;
    const body = s.text ?? (s.html ? htmlToPlain(s.html) : '');
    return `${SEPARATOR}\n${header}\n\n${body}`;
  });
  const text = [note?.trim(), ...textBlocks].filter(Boolean).join('\n\n');

  if (!sources.some((s) => s.html)) return { text };
  const htmlBlocks = sources.map((s) => {
    const header = headerLines(s.envelope)
      .map(([k, v]) => `${k}: ${escapeHtml(v)}`)
      .join('<br>');
    const body = s.raw ? '<p>(attached as .eml)</p>' : s.html ? bodyOf(s.html) : `<pre>${escapeHtml(s.text ?? '')}</pre>`;
    return `<div>${SEPARATOR}<br>${header}</div><br>${body}`;
  });
  const noteHtml = note?.trim() ? `<div>${escapeHtml(note.trim()).replace(/\n/g, '<br>')}</div><br>` : '';
  return { text, html: `${noteHtml}${htmlBlocks.join('<br><br>')}` };
}
