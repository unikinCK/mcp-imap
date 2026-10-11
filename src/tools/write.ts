import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import { z } from 'zod';
import type { AccountConfig, ServerConfig } from '../config.js';
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
    .optional(),
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
};

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

async function buildMessage(account: AccountConfig, args: ComposeArgs, reply?: ReplyContext) {
  const to = args.to ?? reply?.replyTo;
  if (!args.text && !args.html) throw new ToolError('Either text or html body is required.');
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
    text: args.text,
    html: args.html,
    date: new Date(),
    messageId: `<${randomUUID()}@${domain}>`,
    attachments: args.attachments?.map((a) => {
      if (a.content === undefined && a.content_base64 === undefined) {
        throw new ToolError(`Attachment "${a.filename}" needs content or content_base64.`);
      }
      return a.content_base64 !== undefined
        ? { filename: a.filename, content: Buffer.from(a.content_base64, 'base64'), contentType: a.content_type }
        : { filename: a.filename, content: a.content, contentType: a.content_type };
    }),
  };
  if (reply?.messageId) {
    options.inReplyTo = reply.messageId;
    options.references = [reply.references, reply.messageId].filter(Boolean).join(' ');
  }
  const mail = new MailComposer(options).compile();
  const raw = await mail.build();
  return { raw, envelope: mail.getEnvelope(), messageId: options.messageId as string };
}

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

export function registerWriteTools(server: McpServer, accounts: AccountManager, config: ServerConfig): void {
  server.registerTool(
    'update_flags',
    {
      title: 'Update message flags',
      description:
        'Adds and/or removes flags on messages, e.g. mark as read (add "seen"), unread (remove "seen"), ' +
        'flag/star (add "flagged") or set custom keywords.',
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
      return accounts.withMailbox(account, mailbox, true, async (client) => {
        const range = uids.join(',');
        if (addFlags.length) await client.messageFlagsAdd(range, addFlags, { uid: true });
        if (removeFlags.length) await client.messageFlagsRemove(range, removeFlags, { uid: true });
        const after = await client.fetchAll(range, { uid: true, flags: true }, { uid: true });
        return json({ mailbox, updated: after.map((m) => ({ uid: m.uid, flags: [...(m.flags ?? [])] })) });
      });
    }),
  );

  server.registerTool(
    'move_messages',
    {
      title: 'Move messages',
      description: 'Moves messages to another mailbox. Returns the new UIDs in the destination if the server reports them.',
      inputSchema: { account: accountArg, mailbox: mailboxArg, uids: uidsArg, destination: z.string() },
      annotations: { ...WRITE, idempotentHint: false },
    },
    handler(async ({ account, mailbox, uids, destination }) =>
      accounts.withMailbox(account, mailbox, true, async (client) => {
        if (destination === mailbox) throw new ToolError('Source and destination are the same mailbox.');
        const result = await client.messageMove(uids.join(','), destination, { uid: true });
        if (!result) throw new ToolError('Move failed.');
        return json({ from: mailbox, to: result.destination, uidMap: result.uidMap ? Object.fromEntries(result.uidMap) : undefined });
      }),
    ),
  );

  server.registerTool(
    'copy_messages',
    {
      title: 'Copy messages',
      description: 'Copies messages to another mailbox.',
      inputSchema: { account: accountArg, mailbox: mailboxArg, uids: uidsArg, destination: z.string() },
      annotations: { ...WRITE, idempotentHint: false },
    },
    handler(async ({ account, mailbox, uids, destination }) =>
      accounts.withMailbox(account, mailbox, true, async (client) => {
        const result = await client.messageCopy(uids.join(','), destination, { uid: true });
        if (!result) throw new ToolError('Copy failed.');
        return json({ from: mailbox, to: result.destination, uidMap: result.uidMap ? Object.fromEntries(result.uidMap) : undefined });
      }),
    ),
  );

  server.registerTool(
    'delete_messages',
    {
      title: 'Delete messages',
      description:
        'Deletes messages. By default they are moved to the Trash mailbox. With permanent=true (or when already in Trash) ' +
        'they are flagged \\Deleted and expunged, which cannot be undone.',
      inputSchema: {
        account: accountArg,
        mailbox: mailboxArg,
        uids: uidsArg,
        permanent: z.boolean().default(false),
      },
      annotations: DESTRUCTIVE,
    },
    handler(async ({ account, mailbox, uids, permanent }) => {
      accounts.assertWritable(account);
      const trash = permanent ? undefined : await accounts.withClient(account, (client) => findSpecialUse(client, '\\Trash'));
      if (!permanent && !trash) {
        throw new ToolError('No Trash mailbox found. Use move_messages, or permanent=true to delete permanently.');
      }
      const toTrash = !permanent && trash && trash.path !== mailbox;
      return accounts.withMailbox(account, mailbox, true, async (client) => {
        const range = uids.join(',');
        if (toTrash) {
          const result = await client.messageMove(range, trash.path, { uid: true });
          if (!result) throw new ToolError('Moving to Trash failed.');
          return json({ mailbox, movedTo: trash.path, uids });
        }
        const ok = await client.messageDelete(range, { uid: true });
        if (!ok) throw new ToolError('Delete failed.');
        return json({ mailbox, permanentlyDeleted: uids });
      });
    }),
  );

  server.registerTool(
    'create_mailbox',
    {
      title: 'Create mailbox',
      description: 'Creates a new mailbox (folder). Use the server delimiter (see list_mailboxes) for nested folders.',
      inputSchema: { account: accountArg, path: z.string().min(1) },
      annotations: { ...WRITE, idempotentHint: false },
    },
    handler(async ({ account, path }) => {
      accounts.assertWritable(account);
      return accounts.withClient(account, async (client) => json(await client.mailboxCreate(path)));
    }),
  );

  server.registerTool(
    'rename_mailbox',
    {
      title: 'Rename mailbox',
      description: 'Renames or moves a mailbox (folder).',
      inputSchema: { account: accountArg, path: z.string().min(1), new_path: z.string().min(1) },
      annotations: { ...WRITE, idempotentHint: false },
    },
    handler(async ({ account, path, new_path }) => {
      accounts.assertWritable(account);
      if (path.toUpperCase() === 'INBOX') throw new ToolError('INBOX cannot be renamed.');
      return accounts.withClient(account, async (client) => json(await client.mailboxRename(path, new_path)));
    }),
  );

  server.registerTool(
    'delete_mailbox',
    {
      title: 'Delete mailbox',
      description: 'Deletes a mailbox (folder) and all messages in it. This cannot be undone.',
      inputSchema: { account: accountArg, path: z.string().min(1) },
      annotations: DESTRUCTIVE,
    },
    handler(async ({ account, path }) => {
      accounts.assertWritable(account);
      if (path.toUpperCase() === 'INBOX') throw new ToolError('INBOX cannot be deleted.');
      return accounts.withClient(account, async (client) => json(await client.mailboxDelete(path)));
    }),
  );

  server.registerTool(
    'save_draft',
    {
      title: 'Save draft',
      description:
        'Composes a message and stores it in the Drafts mailbox without sending it. ' +
        'Use reply_to_message to create a threaded reply.',
      inputSchema: {
        ...composeSchema,
        drafts_mailbox: z.string().optional().describe('Overrides the auto-detected Drafts mailbox.'),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    handler(async (args) => {
      accounts.assertWritable(args.account);
      return accounts.withClient(args.account, async (client, account) => {
        const reply = args.reply_to_message ? await loadReplyContext(client, args.reply_to_message) : undefined;
        const { raw, messageId } = await buildMessage(account, args, reply);
        const drafts = args.drafts_mailbox ?? (await findSpecialUse(client, '\\Drafts'))?.path;
        if (!drafts) throw new ToolError('No Drafts mailbox found. Pass drafts_mailbox explicitly.');
        const result = await client.append(drafts, raw, ['\\Draft', '\\Seen']);
        if (!result) throw new ToolError('Saving the draft failed.');
        return json({ savedTo: drafts, uid: result.uid, messageId });
      });
    }),
  );

  const canSendSomewhere = config.allowSend && accounts.list().some((a) => a.smtp && accounts.isWritable(a.name));
  if (!canSendSomewhere) return;

  server.registerTool(
    'send_email',
    {
      title: 'Send email',
      description:
        'Sends an email via the SMTP server configured for the account and (by default) stores a copy in the Sent mailbox. ' +
        'Use reply_to_message to send a threaded reply; the original is then flagged as answered. ' +
        'Always confirm recipients and content with the user before sending.',
      inputSchema: {
        ...composeSchema,
        save_to_sent: z.boolean().optional().describe('Store a copy in the Sent mailbox (default from account config).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handler(async (args) => {
      accounts.assertWritable(args.account);
      const account = accounts.get(args.account);
      const smtp = account.smtp;
      if (!smtp) throw new ToolError(`Account "${account.name}" has no SMTP server configured.`);
      if (!args.to && !args.cc && !args.bcc && !args.reply_to_message) throw new ToolError('At least one recipient is required.');

      return accounts.withClient(args.account, async (client) => {
        const reply = args.reply_to_message ? await loadReplyContext(client, args.reply_to_message) : undefined;
        const { raw, envelope, messageId } = await buildMessage(account, args, reply);
        if (!envelope.to?.length) throw new ToolError('At least one recipient is required.');

        const transport = nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.secure,
          auth: smtp.user ? { user: smtp.user, pass: smtp.password ?? '' } : undefined,
          tls: { rejectUnauthorized: smtp.tlsRejectUnauthorized },
        });
        let info;
        try {
          info = await transport.sendMail({ envelope, raw });
        } finally {
          transport.close();
        }

        let savedTo: string | undefined;
        let saveError: string | undefined;
        if (args.save_to_sent ?? smtp.saveToSent) {
          try {
            const sent = (await findSpecialUse(client, '\\Sent'))?.path;
            if (sent && (await client.append(sent, raw, ['\\Seen']))) savedTo = sent;
            else saveError = 'No Sent mailbox found.';
          } catch (err) {
            saveError = (err as Error).message;
          }
        }
        if (reply) {
          const lock = await client.getMailboxLock(reply.mailbox);
          try {
            await client.messageFlagsAdd(String(reply.uid), ['\\Answered'], { uid: true });
          } finally {
            lock.release();
          }
        }
        return json({
          messageId,
          accepted: info.accepted,
          rejected: info.rejected,
          response: info.response,
          savedTo,
          ...(saveError ? { saveError } : {}),
        });
      });
    }),
  );
}
