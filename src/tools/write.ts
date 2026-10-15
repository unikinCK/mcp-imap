import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FetchMessageObject, ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import { z } from 'zod';
import type { AccountConfig, ServerConfig, SmtpSettings } from '../config.js';
import { AuditLog, describeMessages } from '../audit.js';
import {
  type AttachmentRef,
  ByteBudget,
  forwardBodies,
  forwardSubject,
  loadAttachmentRefs,
  loadForwardSource,
} from '../forward.js';
import { ownAddresses, replyBodies, replyRecipients, replySubject } from '../reply.js';
import { type AccountManager, findSpecialUse, ToolError } from '../imap.js';
import { formatAddresses, parseHeaders } from '../messages.js';
import { accountArg, handler, json, mailboxArg, uidsArg } from './common.js';

const SYSTEM_FLAGS: Record<string, string> = {
  seen: '\\Seen',
  read: '\\Seen',
  flagged: '\\Flagged',
  starred: '\\Flagged',
  answered: '\\Answered',
  draft: '\\Draft',
};

const flagArg = z
  .string()
  .regex(/^\\?[A-Za-z0-9$_.\-]+$/, 'Flag must be a single word, e.g. "seen", "flagged" or a custom keyword')
  .describe('"seen", "flagged", "answered", "draft" or a custom keyword such as "$label1".');

function toImapFlag(flag: string): string {
  const mapped = SYSTEM_FLAGS[flag.replace(/^\\/, '').toLowerCase()];
  if (mapped) return mapped;
  if (flag.toLowerCase() === '\\deleted' || flag.toLowerCase() === 'deleted') {
    throw new ToolError('Use delete_messages to delete messages instead of setting \\Deleted.');
  }
  if (flag.startsWith('\\')) throw new ToolError(`Unsupported system flag ${flag}.`);
  return flag;
}

const addressList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe('One address or a list, e.g. "Jane Doe <jane@example.com>".');

const composeSchema = {
  account: accountArg,
  to: addressList,
  cc: addressList,
  bcc: addressList,
  subject: z.string().optional().describe('Defaults to "Re: <original subject>" when replying.'),
  text: z.string().optional().describe('Plain text body.'),
  html: z.string().optional().describe('HTML body (optional, in addition to or instead of text).'),
  reply_to_message: z
    .object({ mailbox: z.string().default('INBOX'), uid: z.number().int().positive() })
    .optional()
    .describe('Reply to this message: sets In-Reply-To/References and defaults recipient and subject.'),
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        content: z.string().optional().describe('Text content.'),
        content_base64: z.string().optional().describe('Binary content, base64 encoded.'),
        content_type: z.string().optional(),
      }),
    )
    .max(20)
    .optional()
    .describe('New attachments provided as text or base64. To reuse attachments of existing messages use attach_from_messages.'),
  attach_from_messages: z
    .array(
      z.object({
        mailbox: z.string().default('INBOX'),
        uid: z.number().int().positive(),
        part: z.string().optional().describe('Attachment part id from get_message; omit to attach all attachments of the message.'),
      }),
    )
    .max(20)
    .optional()
    .describe(
      'Attach attachments of existing messages. They are copied on the server, so even large files (PDFs) work ' +
        'without transferring their content through the conversation.',
    ),
};

type ComposeArgs = {
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  reply_to_message?: { mailbox: string; uid: number };
  attachments?: { filename: string; content?: string; content_base64?: string; content_type?: string }[];
  attach_from_messages?: AttachmentRef[];
};

interface ComposeExtra {
  attachments?: Mail.Attachment[];
  text?: string;
  html?: string;
  references?: string;
}

interface ReplyContext {
  mailbox: string;
  uid: number;
  messageId?: string;
  references?: string;
  subject?: string;
  replyTo?: string[];
}

async function loadReplyContext(client: ImapFlow, ref: { mailbox: string; uid: number }): Promise<ReplyContext> {
  const lock = await client.getMailboxLock(ref.mailbox, { readOnly: true });
  try {
    const msg = await client.fetchOne(String(ref.uid), { uid: true, envelope: true, headers: ['references'] }, { uid: true });
    if (!msg) throw new ToolError(`Message UID ${ref.uid} not found in "${ref.mailbox}".`);
    const env = msg.envelope ?? {};
    return {
      ...ref,
      messageId: env.messageId,
      references: parseHeaders(msg.headers)['references']?.join(' '),
      subject: env.subject,
      replyTo: formatAddresses(env.replyTo?.length ? env.replyTo : env.from),
    };
  } finally {
    lock.release();
  }
}

function fromAddress(account: AccountConfig): string {
  return account.smtp?.from ?? account.imap.user;
}

async function buildMessage(account: AccountConfig, args: ComposeArgs, reply?: ReplyContext, extra: ComposeExtra = {}) {
  const to = args.to ?? reply?.replyTo;
  const text = extra.text ?? args.text;
  const html = extra.html ?? args.html;
  if (!text && !html) throw new ToolError('Either text or html body is required.');
  let subject = args.subject;
  if (subject === undefined && reply) {
    const original = reply.subject ?? '';
    subject = /^re:/i.test(original) ? original : `Re: ${original}`;
  }
  const from = fromAddress(account);
  const domain = /@([^>\s]+)/.exec(from)?.[1] ?? 'localhost';
  const options: Mail.Options = {
    from,
    to,
    cc: args.cc,
    bcc: args.bcc,
    subject: subject ?? '',
    text,
    html,
    date: new Date(),
    messageId: `<${randomUUID()}@${domain}>`,
    attachments: [
      ...(args.attachments ?? []).map((a): Mail.Attachment => {
        if (a.content === undefined && a.content_base64 === undefined) {
          throw new ToolError(`Attachment "${a.filename}" needs content or content_base64.`);
        }
        return a.content_base64 !== undefined
          ? { filename: a.filename, content: Buffer.from(a.content_base64, 'base64'), contentType: a.content_type }
          : { filename: a.filename, content: a.content, contentType: a.content_type };
      }),
      ...(extra.attachments ?? []),
    ],
  };
  if (extra.references) options.references = extra.references;
  if (reply?.messageId) {
    options.inReplyTo = reply.messageId;
    options.references = [reply.references, reply.messageId].filter(Boolean).join(' ');
  }
  const mail = new MailComposer(options).compile();
  const raw = await mail.build();
  const attachmentNames = (options.attachments ?? []).map((a) => a.filename || (a.cid ? `inline:${a.cid}` : 'unnamed'));
  return {
    raw,
    envelope: mail.getEnvelope(),
    messageId: options.messageId as string,
    subject: options.subject as string,
    attachmentNames,
  };
}

/**
 * Sends a composed message via SMTP, stores a copy in Sent (optional) and flags the answered
 * original. Used by send_email and reply_message.
 */
async function deliver(
  client: ImapFlow,
  smtp: SmtpSettings,
  raw: Buffer,
  envelope: { from: string | false; to: string[] },
  saveToSent: boolean,
  answered?: { mailbox: string; uid: number },
) {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password ?? '' } : undefined,
    tls: { rejectUnauthorized: smtp.tlsRejectUnauthorized },
  });
  let info;
  try {
    info = await transport.sendMail({ envelope: { from: envelope.from || undefined, to: envelope.to }, raw });
  } finally {
    transport.close();
  }

  let savedTo: string | undefined;
  let saveError: string | undefined;
  if (saveToSent) {
    try {
      const sent = (await findSpecialUse(client, '\\Sent'))?.path;
      if (sent && (await client.append(sent, raw, ['\\Seen']))) savedTo = sent;
      else saveError = 'No Sent mailbox found.';
    } catch (err) {
      saveError = (err as Error).message;
    }
  }
  if (answered) {
    const lock = await client.getMailboxLock(answered.mailbox);
    try {
      await client.messageFlagsAdd(String(answered.uid), ['\\Answered'], { uid: true });
    } finally {
      lock.release();
    }
  }
  return { info, savedTo, saveError };
}

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

interface MoveResult {
  destination: string;
  uidMap: Record<number, number>;
  moved: number[];
  /** Copied, but the copy could not be verified, so the original was kept. */
  unverified: number[];
  notFound: number[];
}

/**
 * Moves messages as a verified copy: COPY, check that every copy exists in the destination with
 * the same size and Message-ID, and only then remove exactly those originals (UID EXPUNGE).
 * Originals whose copy cannot be verified are kept.
 */
async function verifiedMove(client: ImapFlow, from: string, uids: number[], to: string): Promise<MoveResult> {
  if (!client.capabilities.has('UIDPLUS')) {
    throw new ToolError('The server does not support UIDPLUS, so moves cannot be verified. Nothing was changed.');
  }
  let lock = await client.getMailboxLock(from);
  let source: FetchMessageObject[];
  let copy;
  try {
    source = await client.fetchAll(uids.join(','), { uid: true, size: true, envelope: true }, { uid: true });
    if (!source.length) throw new ToolError(`None of the given messages exist in "${from}".`);
    copy = await client.messageCopy(source.map((m) => m.uid).join(','), to, { uid: true });
  } finally {
    lock.release();
  }
  if (!copy) throw new ToolError('Copy failed. Nothing was changed.');
  const uidMap = copy.uidMap ?? new Map<number, number>();
  const destination = copy.destination ?? to;

  lock = await client.getMailboxLock(destination, { readOnly: true });
  let copies: FetchMessageObject[] = [];
  try {
    const newUids = [...uidMap.values()];
    if (newUids.length) copies = await client.fetchAll(newUids.join(','), { uid: true, size: true, envelope: true }, { uid: true });
  } finally {
    lock.release();
  }
  const byUid = new Map(copies.map((m) => [m.uid, m]));
  const verified: number[] = [];
  const unverified: number[] = [];
  for (const original of source) {
    const target = uidMap.has(original.uid) ? byUid.get(uidMap.get(original.uid)!) : undefined;
    const same =
      target !== undefined &&
      target.size === original.size &&
      (target.envelope?.messageId ?? '') === (original.envelope?.messageId ?? '');
    (same ? verified : unverified).push(original.uid);
  }

  if (verified.length) {
    lock = await client.getMailboxLock(from);
    try {
      if (!(await client.messageDelete(verified.join(','), { uid: true }))) {
        throw new ToolError(`Messages were copied to "${destination}", but removing the originals from "${from}" failed.`);
      }
    } finally {
      lock.release();
    }
  }
  const found = new Set(source.map((m) => m.uid));
  return {
    destination,
    uidMap: Object.fromEntries([...uidMap].filter(([src]) => verified.includes(src))),
    moved: verified,
    unverified,
    notFound: uids.filter((uid) => !found.has(uid)),
  };
}

export function registerWriteTools(server: McpServer, accounts: AccountManager, config: ServerConfig): void {
  const audit = new AuditLog(config.logFolder, config.actor ?? 'unknown client');
  const logNote = audit.enabled ? ` Every change is recorded in the "${audit.folder}" folder.` : '';

  server.registerTool(
    'update_flags',
    {
      title: 'Update message flags',
      description:
        'Adds and/or removes flags on messages, e.g. mark as read (add "seen"), unread (remove "seen"), ' +
        'flag/star (add "flagged") or set custom keywords.' + logNote,
      inputSchema: {
        account: accountArg,
        mailbox: mailboxArg,
        uids: uidsArg,
        add: z.array(flagArg).optional(),
        remove: z.array(flagArg).optional(),
      },
      annotations: WRITE,
    },
    handler(async ({ account, mailbox, uids, add, remove }) => {
      const addFlags = (add ?? []).map(toImapFlag);
      const removeFlags = (remove ?? []).map(toImapFlag);
      if (!addFlags.length && !removeFlags.length) throw new ToolError('Nothing to do: provide add and/or remove.');
      return accounts.withMailbox(account, mailbox, true, async (client, acc) => {
        audit.assertNotLogFolder(client, mailbox);
        const range = uids.join(',');
        const messages = await describeMessages(client, uids);
        if (addFlags.length) await client.messageFlagsAdd(range, addFlags, { uid: true });
        if (removeFlags.length) await client.messageFlagsRemove(range, removeFlags, { uid: true });
        const after = await client.fetchAll(range, { uid: true, flags: true }, { uid: true });
        const change = [...addFlags.map((f) => `+${f}`), ...removeFlags.map((f) => `-${f}`)].join(' ');
        const log = await audit.write(client, acc, {
          action: 'update_flags',
          summary: `Flags ${change} on ${messages.length} message(s) in ${mailbox}`,
          mailbox,
          messages,
        });
        return json({ mailbox, updated: after.map((m) => ({ uid: m.uid, flags: [...(m.flags ?? [])] })), ...log });
      });
    }),
  );

  server.registerTool(
    'move_messages',
    {
      title: 'Move messages',
      description:
        'Moves messages to another mailbox as a verified copy: the messages are copied, each copy is checked in the ' +
        'destination, and only then the originals are removed. Originals whose copy cannot be verified are kept.' +
        ' Moving to Trash requires delete permission.' +
        logNote,
      inputSchema: { account: accountArg, mailbox: mailboxArg, uids: uidsArg, destination: z.string() },
      annotations: { ...WRITE, idempotentHint: false },
    },
    handler(async ({ account, mailbox, uids, destination }) => {
      accounts.assertWritable(account);
      if (destination === mailbox) throw new ToolError('Source and destination are the same mailbox.');
      return accounts.withClient(account, async (client, acc) => {
        audit.assertNotLogFolder(client, mailbox, destination);
        if (!accounts.canDelete(account)) {
          const trash = await findSpecialUse(client, '\\Trash');
          if (trash && trash.path.toLowerCase() === destination.toLowerCase()) {
            throw new ToolError('Moving messages to Trash counts as deleting, which is not permitted.');
          }
        }
        const lock = await client.getMailboxLock(mailbox, { readOnly: true });
        let messages;
        try {
          messages = await describeMessages(client, uids);
        } finally {
          lock.release();
        }
        const result = await verifiedMove(client, mailbox, uids, destination);
        const log = await audit.write(client, acc, {
          action: 'move_messages',
          summary: `Moved ${result.moved.length} message(s) ${mailbox} -> ${result.destination}`,
          mailbox,
          messages: messages.filter((m) => result.moved.includes(m.uid)),
          details: {
            destination: result.destination,
            newUids: result.uidMap,
            ...(result.unverified.length ? { notVerifiedKeptOriginals: result.unverified } : {}),
          },
        });
        return json({
          from: mailbox,
          to: result.destination,
          moved: result.moved,
          uidMap: result.uidMap,
          ...(result.unverified.length
            ? {
                unverified: result.unverified,
                warning: 'These messages were copied but the copy could not be verified; the originals were kept.',
              }
            : {}),
          ...(result.notFound.length ? { notFound: result.notFound } : {}),
          ...log,
        });
      });
    }),
  );

  server.registerTool(
    'copy_messages',
    {
      title: 'Copy messages',
      description: 'Copies messages to another mailbox.' + logNote,
      inputSchema: { account: accountArg, mailbox: mailboxArg, uids: uidsArg, destination: z.string() },
      annotations: { ...WRITE, idempotentHint: false },
    },
    handler(async ({ account, mailbox, uids, destination }) =>
      accounts.withMailbox(account, mailbox, true, async (client, acc) => {
        audit.assertNotLogFolder(client, mailbox, destination);
        const messages = await describeMessages(client, uids);
        const result = await client.messageCopy(uids.join(','), destination, { uid: true });
        if (!result) throw new ToolError('Copy failed.');
        const uidMap = result.uidMap ? Object.fromEntries(result.uidMap) : undefined;
        const log = await audit.write(client, acc, {
          action: 'copy_messages',
          summary: `Copied ${messages.length} message(s) ${mailbox} -> ${result.destination}`,
          mailbox,
          messages,
          details: { destination: result.destination, newUids: uidMap },
        });
        return json({ from: mailbox, to: result.destination, uidMap, ...log });
      }),
    ),
  );

  server.registerTool(
    'create_mailbox',
    {
      title: 'Create mailbox',
      description: 'Creates a new mailbox (folder). Use the server delimiter (see list_mailboxes) for nested folders.' + logNote,
      inputSchema: { account: accountArg, path: z.string().min(1) },
      annotations: { ...WRITE, idempotentHint: false },
    },
    handler(async ({ account, path }) => {
      accounts.assertWritable(account);
      return accounts.withClient(account, async (client, acc) => {
        const result = await client.mailboxCreate(path);
        const log = await audit.write(client, acc, { action: 'create_mailbox', summary: `Created folder ${result.path}` });
        return json({ ...result, ...log });
      });
    }),
  );

  server.registerTool(
    'rename_mailbox',
    {
      title: 'Rename mailbox',
      description: 'Renames or moves a mailbox (folder).' + logNote,
      inputSchema: { account: accountArg, path: z.string().min(1), new_path: z.string().min(1) },
      annotations: { ...WRITE, idempotentHint: false },
    },
    handler(async ({ account, path, new_path }) => {
      accounts.assertWritable(account);
      if (path.toUpperCase() === 'INBOX') throw new ToolError('INBOX cannot be renamed.');
      return accounts.withClient(account, async (client, acc) => {
        audit.assertNotLogFolder(client, path, new_path);
        const result = await client.mailboxRename(path, new_path);
        const log = await audit.write(client, acc, {
          action: 'rename_mailbox',
          summary: `Renamed folder ${result.path} -> ${result.newPath}`,
        });
        return json({ ...result, ...log });
      });
    }),
  );

  server.registerTool(
    'save_draft',
    {
      title: 'Save draft',
      description:
        'Composes a message and stores it in the Drafts mailbox without sending it. ' +
        'Use reply_to_message to create a threaded reply.' + logNote,
      inputSchema: {
        ...composeSchema,
        drafts_mailbox: z.string().optional().describe('Overrides the auto-detected Drafts mailbox.'),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    handler(async (args) => {
      accounts.assertWritable(args.account);
      return accounts.withClient(args.account, async (client, account) => {
        audit.assertNotLogFolder(client, args.drafts_mailbox);
        const reply = args.reply_to_message ? await loadReplyContext(client, args.reply_to_message) : undefined;
        const attachments = await loadAttachmentRefs(client, args.attach_from_messages ?? [], new ByteBudget());
        const { raw, messageId, envelope, subject, attachmentNames } = await buildMessage(account, args, reply, { attachments });
        const drafts = args.drafts_mailbox ?? (await findSpecialUse(client, '\\Drafts'))?.path;
        if (!drafts) throw new ToolError('No Drafts mailbox found. Pass drafts_mailbox explicitly.');
        const result = await client.append(drafts, raw, ['\\Draft', '\\Seen']);
        if (!result) throw new ToolError('Saving the draft failed.');
        const log = await audit.write(client, account, {
          action: 'save_draft',
          summary: `Draft saved: "${subject}"`,
          mailbox: drafts,
          details: { to: envelope.to, uid: result.uid, messageId, inReplyTo: reply?.messageId, attachments: attachmentNames },
        });
        return json({ savedTo: drafts, uid: result.uid, messageId, attachments: attachmentNames, ...log });
      });
    }),
  );

  server.registerTool(
    'forward_messages',
    {
      title: 'Forward messages as draft',
      description:
        'Creates a forward of one or more messages and stores it in the Drafts mailbox (it is not sent). The original ' +
        'text and ALL original attachments (including PDFs and inline images) are copied on the server, so nothing has ' +
        'to be transferred through the conversation. mode "inline" (default) quotes the original below your note; ' +
        'mode "attachment" attaches each original as .eml file.' + logNote,
      inputSchema: {
        account: accountArg,
        mailbox: mailboxArg,
        uids: z.array(z.number().int().positive()).min(1).max(20).describe('Messages to forward (UIDs in mailbox).'),
        to: addressList,
        cc: addressList,
        bcc: addressList,
        note: z.string().optional().describe('Your text above the forwarded message(s).'),
        subject: z.string().optional().describe('Defaults to "Fwd: <original subject>".'),
        mode: z.enum(['inline', 'attachment']).default('inline'),
        attach_from_messages: composeSchema.attach_from_messages,
        drafts_mailbox: z.string().optional().describe('Overrides the auto-detected Drafts mailbox.'),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    handler(async (args) => {
      accounts.assertWritable(args.account);
      return accounts.withClient(args.account, async (client, account) => {
        audit.assertNotLogFolder(client, args.drafts_mailbox);
        const budget = new ByteBudget();
        const asAttachment = args.mode === 'attachment';
        const sources = [];
        for (const uid of args.uids) sources.push(await loadForwardSource(client, args.mailbox, uid, asAttachment, budget));
        const extraAttachments = await loadAttachmentRefs(client, args.attach_from_messages ?? [], budget);

        const attachments = sources.flatMap((s) =>
          s.raw
            ? [
                {
                  filename: `${(s.envelope.subject || 'message').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)}.eml`,
                  content: s.raw,
                  contentType: 'message/rfc822',
                },
              ]
            : s.attachments,
        );
        const bodies = forwardBodies(args.note, sources);
        const { raw, messageId, subject, attachmentNames, envelope } = await buildMessage(
          account,
          { to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject ?? forwardSubject(sources) },
          undefined,
          {
            text: bodies.text,
            html: bodies.html,
            attachments: [...attachments, ...extraAttachments],
            references: sources.length === 1 ? [sources[0].references, sources[0].messageId].filter(Boolean).join(' ') || undefined : undefined,
          },
        );
        const drafts = args.drafts_mailbox ?? (await findSpecialUse(client, '\\Drafts'))?.path;
        if (!drafts) throw new ToolError('No Drafts mailbox found. Pass drafts_mailbox explicitly.');
        const result = await client.append(drafts, raw, ['\\Draft', '\\Seen']);
        if (!result) throw new ToolError('Saving the forward draft failed.');

        const lock = await client.getMailboxLock(args.mailbox, { readOnly: true });
        let messages;
        try {
          messages = await describeMessages(client, args.uids);
        } finally {
          lock.release();
        }
        const log = await audit.write(client, account, {
          action: 'forward_messages',
          summary: `Forward draft saved: "${subject}" (${sources.length} message(s), ${attachmentNames.length} attachment(s))`,
          mailbox: args.mailbox,
          messages,
          details: { to: envelope.to, mode: args.mode, draftsMailbox: drafts, uid: result.uid, attachments: attachmentNames },
        });
        return json({
          savedTo: drafts,
          uid: result.uid,
          messageId,
          subject,
          to: envelope.to,
          attachments: attachmentNames,
          sizeBytes: raw.length,
          ...log,
        });
      });
    }),
  );

  const toList = (value?: string | string[]) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
  const anySend = accounts.list().some((a) => accounts.canSend(a.name));

  server.registerTool(
    'reply_message',
    {
      title: 'Reply to a message',
      description:
        'Replies to a message like a mail client: recipient from Reply-To/From (reply_all adds To and Cc without your ' +
        'own addresses), subject "Re: ...", threading headers, and the original quoted below your text. By default ' +
        'the reply is stored as draft in Drafts.' +
        (anySend
          ? ' With send=true it is sent immediately (confirm recipients and content with the user first), stored in Sent and the original is flagged as answered.'
          : ' Sending is not permitted, so replies are always saved as drafts.') +
        logNote,
      inputSchema: {
        account: accountArg,
        mailbox: mailboxArg,
        uid: z.number().int().positive().describe('UID of the message to reply to.'),
        text: z.string().optional().describe('Your reply (plain text). Either text or html is required.'),
        html: z.string().optional().describe('Your reply as HTML (optional).'),
        reply_all: z.boolean().default(false).describe('Also reply to all other To and Cc recipients.'),
        to: addressList.describe('Additional To recipients.'),
        cc: addressList.describe('Additional Cc recipients.'),
        bcc: addressList,
        subject: z.string().optional().describe('Defaults to "Re: <original subject>".'),
        quote: z.boolean().default(true).describe('Quote the original message below the reply.'),
        language: z
          .enum(['en', 'de'])
          .default('en')
          .describe('Language of the quote header ("On ... wrote:" / "Am ... schrieb ...:"); use the language of the reply.'),
        include_attachments: z.boolean().default(false).describe('Attach the attachments of the original message.'),
        attach_from_messages: composeSchema.attach_from_messages,
        send: z.boolean().default(false).describe('Send immediately instead of saving a draft (needs send permission).'),
        save_to_sent: z.boolean().optional().describe('When sending: store a copy in Sent (default from account config).'),
        drafts_mailbox: z.string().optional().describe('Overrides the auto-detected Drafts mailbox.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handler(async (args) => {
      if (args.send) accounts.assertCanSend(args.account);
      else accounts.assertWritable(args.account);
      if (!args.text && !args.html) throw new ToolError('Either text or html is required.');
      return accounts.withClient(args.account, async (client, account) => {
        audit.assertNotLogFolder(client, args.drafts_mailbox);
        const budget = new ByteBudget();
        const attachmentMode = args.include_attachments ? 'all' : args.quote ? 'inline' : 'none';
        const source = await loadForwardSource(client, args.mailbox, args.uid, false, budget, attachmentMode);
        const extraAttachments = await loadAttachmentRefs(client, args.attach_from_messages ?? [], budget);

        const recipients = replyRecipients(source.envelope, ownAddresses(account), args.reply_all);
        const to = [...recipients.to, ...toList(args.to)];
        const cc = [...recipients.cc, ...toList(args.cc)];
        if (!to.length && args.send) throw new ToolError('Could not determine a recipient. Pass "to" explicitly.');
        const bodies = args.quote ? replyBodies(args.text, args.html, source, args.language) : { text: args.text, html: args.html };
        const reply = {
          mailbox: args.mailbox,
          uid: args.uid,
          messageId: source.messageId,
          references: source.references,
          subject: source.envelope.subject,
        };
        const { raw, envelope, messageId, subject, attachmentNames } = await buildMessage(
          account,
          { to, cc: cc.length ? cc : undefined, bcc: args.bcc, subject: args.subject ?? replySubject(source.envelope.subject) },
          reply,
          { text: bodies.text ?? '', html: bodies.html, attachments: [...source.attachments, ...extraAttachments] },
        );
        const messages = [
          {
            uid: args.uid,
            date: source.envelope.date ? new Date(source.envelope.date).toISOString().slice(0, 16).replace('T', ' ') : undefined,
            from: source.envelope.from?.map((a) => a.address).join(', '),
            subject: source.envelope.subject,
          },
        ];

        if (args.send) {
          const smtp = account.smtp!;
          const { info, savedTo, saveError } = await deliver(
            client,
            smtp,
            raw,
            envelope,
            args.save_to_sent ?? smtp.saveToSent,
            reply,
          );
          const log = await audit.write(client, account, {
            action: 'reply_message',
            summary: `Reply sent: "${subject}" to ${envelope.to.join(', ')}`,
            mailbox: args.mailbox,
            messages,
            details: { recipients: envelope.to, messageId, accepted: info.accepted, rejected: info.rejected, savedTo, attachments: attachmentNames },
          });
          return json({
            sent: true,
            messageId,
            subject,
            to,
            cc,
            accepted: info.accepted,
            rejected: info.rejected,
            savedTo,
            ...(saveError ? { saveError } : {}),
            attachments: attachmentNames,
            ...log,
          });
        }

        const drafts = args.drafts_mailbox ?? (await findSpecialUse(client, '\\Drafts'))?.path;
        if (!drafts) throw new ToolError('No Drafts mailbox found. Pass drafts_mailbox explicitly.');
        const result = await client.append(drafts, raw, ['\\Draft', '\\Seen']);
        if (!result) throw new ToolError('Saving the reply draft failed.');
        const log = await audit.write(client, account, {
          action: 'reply_message',
          summary: `Reply draft saved: "${subject}"${to.length ? ` to ${to.join(', ')}` : ''}`,
          mailbox: args.mailbox,
          messages,
          details: { to, cc, draftsMailbox: drafts, uid: result.uid, messageId, attachments: attachmentNames },
        });
        return json({ sent: false, savedTo: drafts, uid: result.uid, messageId, subject, to, cc, attachments: attachmentNames, ...log });
      });
    }),
  );

  if (accounts.list().some((a) => accounts.canDelete(a.name))) registerDeleteTools(server, accounts, audit, logNote);

  if (!accounts.list().some((a) => accounts.canSend(a.name))) return;

  server.registerTool(
    'send_email',
    {
      title: 'Send email',
      description:
        'Sends an email via the SMTP server configured for the account and (by default) stores a copy in the Sent mailbox. ' +
        'Use reply_to_message to send a threaded reply; the original is then flagged as answered. ' +
        'Always confirm recipients and content with the user before sending.' + logNote,
      inputSchema: {
        ...composeSchema,
        save_to_sent: z.boolean().optional().describe('Store a copy in the Sent mailbox (default from account config).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handler(async (args) => {
      accounts.assertCanSend(args.account);
      const account = accounts.get(args.account);
      const smtp = account.smtp!;
      if (!args.to && !args.cc && !args.bcc && !args.reply_to_message) throw new ToolError('At least one recipient is required.');

      return accounts.withClient(args.account, async (client) => {
        const reply = args.reply_to_message ? await loadReplyContext(client, args.reply_to_message) : undefined;
        const attachments = await loadAttachmentRefs(client, args.attach_from_messages ?? [], new ByteBudget());
        const { raw, envelope, messageId, subject, attachmentNames } = await buildMessage(account, args, reply, { attachments });
        if (!envelope.to?.length) throw new ToolError('At least one recipient is required.');

        const { info, savedTo, saveError } = await deliver(
          client,
          smtp,
          raw,
          envelope,
          args.save_to_sent ?? smtp.saveToSent,
          reply,
        );
        const log = await audit.write(client, account, {
          action: 'send_email',
          summary: `Sent: "${subject}" to ${envelope.to.join(', ')}`,
          details: {
            from: envelope.from,
            recipients: envelope.to,
            messageId,
            inReplyTo: reply?.messageId,
            accepted: info.accepted,
            rejected: info.rejected,
            savedTo,
            attachments: attachmentNames,
          },
        });
        return json({
          messageId,
          accepted: info.accepted,
          rejected: info.rejected,
          response: info.response,
          savedTo,
          ...(saveError ? { saveError } : {}),
          ...log,
        });
      });
    }),
  );
}

function registerDeleteTools(server: McpServer, accounts: AccountManager, audit: AuditLog, logNote: string): void {
  server.registerTool(
    'delete_messages',
    {
      title: 'Delete messages',
      description:
        'Deletes messages. By default they are moved to the Trash mailbox (verified move). With permanent=true (or when ' +
        'already in Trash) they are flagged \\Deleted and expunged, which cannot be undone.' + logNote,
      inputSchema: {
        account: accountArg,
        mailbox: mailboxArg,
        uids: uidsArg,
        permanent: z.boolean().default(false),
      },
      annotations: DESTRUCTIVE,
    },
    handler(async ({ account, mailbox, uids, permanent }) => {
      accounts.assertCanDelete(account);
      return accounts.withClient(account, async (client, acc) => {
        audit.assertNotLogFolder(client, mailbox);
        const trash = permanent ? undefined : await findSpecialUse(client, '\\Trash');
        if (!permanent && !trash) {
          throw new ToolError('No Trash mailbox found. Use move_messages, or permanent=true to delete permanently.');
        }
        const lock = await client.getMailboxLock(mailbox, { readOnly: true });
        let messages;
        try {
          messages = await describeMessages(client, uids);
        } finally {
          lock.release();
        }
        if (trash && trash.path !== mailbox) {
          const result = await verifiedMove(client, mailbox, uids, trash.path);
          const log = await audit.write(client, acc, {
            action: 'delete_messages',
            summary: `Deleted ${result.moved.length} message(s) from ${mailbox} (moved to ${trash.path})`,
            mailbox,
            messages: messages.filter((m) => result.moved.includes(m.uid)),
            details: { trash: trash.path, ...(result.unverified.length ? { notVerifiedKeptOriginals: result.unverified } : {}) },
          });
          return json({ mailbox, movedTo: trash.path, moved: result.moved, unverified: result.unverified, ...log });
        }
        const writeLock = await client.getMailboxLock(mailbox);
        try {
          if (!(await client.messageDelete(uids.join(','), { uid: true }))) throw new ToolError('Delete failed.');
        } finally {
          writeLock.release();
        }
        const log = await audit.write(client, acc, {
          action: 'delete_messages',
          summary: `Permanently deleted ${messages.length} message(s) from ${mailbox}`,
          mailbox,
          messages,
        });
        return json({ mailbox, permanentlyDeleted: messages.map((m) => m.uid), ...log });
      });
    }),
  );

  server.registerTool(
    'delete_mailbox',
    {
      title: 'Delete mailbox',
      description: 'Deletes a mailbox (folder) and all messages in it. This cannot be undone.' + logNote,
      inputSchema: { account: accountArg, path: z.string().min(1) },
      annotations: DESTRUCTIVE,
    },
    handler(async ({ account, path }) => {
      accounts.assertCanDelete(account);
      if (path.toUpperCase() === 'INBOX') throw new ToolError('INBOX cannot be deleted.');
      return accounts.withClient(account, async (client, acc) => {
        audit.assertNotLogFolder(client, path);
        const status = await client.status(path, { messages: true }).catch(() => false as const);
        const result = await client.mailboxDelete(path);
        const log = await audit.write(client, acc, {
          action: 'delete_mailbox',
          summary: `Deleted folder ${result.path}${status ? ` with ${status.messages} message(s)` : ''}`,
        });
        return json({ ...result, ...log });
      });
    }),
  );
}
