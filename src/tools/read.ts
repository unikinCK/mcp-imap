import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchObject } from 'imapflow';
import { z } from 'zod';
import { type AttachmentLinker, resourceUri, uidValidityOf } from '../attachments.js';
import type { ServerConfig } from '../config.js';
import { detectKind, isTextDocument, optionalFeatures } from '../extract/index.js';
import { type AccountManager, ToolError } from '../imap.js';
import {
  analyzeStructure,
  downloadPart,
  fetchSummaries,
  formatAddresses,
  htmlToPlain,
  parseHeaders,
  summarize,
  SUMMARY_QUERY,
  truncate,
} from '../messages.js';
import { accountArg, handler, json, mailboxArg, structured } from './common.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const dateArg = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, 'Use YYYY-MM-DD')
  .optional();

const messageOutput = {
  uid: z.number(),
  mailbox: z.string(),
  date: z.string().optional(),
  from: z.array(z.string()).optional(),
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  replyTo: z.array(z.string()).optional(),
  subject: z.string(),
  flags: z.array(z.string()),
  size: z.number().optional(),
  hasAttachments: z.boolean().optional(),
  messageId: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.string().optional(),
  listUnsubscribe: z.string().optional(),
  headers: z.record(z.string(), z.array(z.string())).optional(),
  body: z.object({ text: z.string().optional(), html: z.string().optional() }),
  bodyTruncated: z.boolean(),
  attachments: z.array(
    z.object({
      part: z.string(),
      filename: z.string().optional(),
      contentType: z.string(),
      size: z.number().optional(),
      disposition: z.string().optional(),
      contentId: z.string().optional(),
      textAvailable: z.boolean().describe('get_attachment can return this attachment as text.'),
      resourceUri: z.string(),
      downloadUrl: z.string().optional(),
    }),
  ),
  downloadExpiresAt: z.string().optional(),
};

export function registerReadTools(
  server: McpServer,
  accounts: AccountManager,
  config: ServerConfig,
  linker?: AttachmentLinker,
): void {
  const imageOcr = config.extract.ocr !== 'off' && optionalFeatures.tesseract;
  server.registerTool(
    'list_accounts',
    {
      title: 'List accounts',
      description: 'Lists the configured IMAP accounts and whether they can be modified in the current server mode.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    handler(async () =>
      json({
        mode: config.mode,
        auditLogFolder: config.mode === 'read-write' ? config.logFolder : undefined,
        accounts: accounts.list().map((a) => ({
          name: a.name,
          user: a.imap.user,
          host: a.imap.host,
          access: a.access,
          writable: accounts.isWritable(a.name),
          canDelete: accounts.canDelete(a.name),
          canSend: accounts.canSend(a.name),
        })),
      }),
    ),
  );

  server.registerTool(
    'list_mailboxes',
    {
      title: 'List mailboxes',
      description:
        'Lists all mailboxes (folders) of an account including special-use flags (\\Inbox, \\Sent, \\Trash, ...). ' +
        'Optionally includes message and unseen counts.',
      inputSchema: {
        account: accountArg,
        include_counts: z.boolean().default(false).describe('Include total and unseen message counts (slower).'),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ account, include_counts }) =>
      accounts.withClient(account, async (client) => {
        const list = await client.list(include_counts ? { statusQuery: { messages: true, unseen: true } } : undefined);
        return json(
          list.map((box) => ({
            path: box.path,
            name: box.name,
            delimiter: box.delimiter,
            specialUse: box.specialUse,
            flags: [...box.flags],
            subscribed: box.subscribed,
            ...(box.status ? { messages: box.status.messages, unseen: box.status.unseen } : {}),
          })),
        );
      }),
    ),
  );

  server.registerTool(
    'mailbox_status',
    {
      title: 'Mailbox status',
      description: 'Returns message count, unseen count, UIDNEXT and UIDVALIDITY for a mailbox.',
      inputSchema: { account: accountArg, mailbox: mailboxArg },
      annotations: READ_ONLY,
    },
    handler(async ({ account, mailbox }) =>
      accounts.withClient(account, async (client) => {
        const status = await client.status(mailbox, { messages: true, unseen: true, recent: true, uidNext: true, uidValidity: true });
        if (!status) throw new ToolError(`Could not get status for mailbox "${mailbox}".`);
        return json(status);
      }),
    ),
  );

  server.registerTool(
    'list_messages',
    {
      title: 'List messages',
      description:
        'Lists messages in a mailbox, newest first, with sender, recipients, subject, date, flags and attachment indicator. ' +
        'Use offset for pagination. Does not mark messages as read.',
      inputSchema: {
        account: accountArg,
        mailbox: mailboxArg,
        limit: z.number().int().min(1).max(200).default(20),
        offset: z.number().int().min(0).default(0).describe('Number of newest messages to skip.'),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ account, mailbox, limit, offset }) =>
      accounts.withMailbox(account, mailbox, false, async (client) => {
        const total = client.mailbox ? client.mailbox.exists : 0;
        const end = total - offset;
        if (end < 1) return json({ mailbox, total, offset, messages: [] });
        const start = Math.max(1, end - limit + 1);
        const messages = await client.fetchAll(`${start}:${end}`, SUMMARY_QUERY);
        messages.sort((a, b) => b.seq - a.seq);
        return json({
          mailbox,
          total,
          offset,
          hasMore: start > 1,
          messages: messages.map((m) => summarize(m, mailbox)),
        });
      }),
    ),
  );

  server.registerTool(
    'search_messages',
    {
      title: 'Search messages',
      description:
        'Searches a mailbox using IMAP SEARCH. All given criteria must match. Results are returned newest first. ' +
        'Dates use YYYY-MM-DD and refer to the received (internal) date.',
      inputSchema: {
        account: accountArg,
        mailbox: mailboxArg,
        text: z.string().optional().describe('Matches anywhere in headers or body.'),
        from: z.string().optional(),
        to: z.string().optional(),
        cc: z.string().optional(),
        subject: z.string().optional(),
        body: z.string().optional(),
        since: dateArg.describe('Received on or after this date (YYYY-MM-DD).'),
        before: dateArg.describe('Received before this date (YYYY-MM-DD).'),
        seen: z.boolean().optional().describe('true = only read messages, false = only unread messages.'),
        flagged: z.boolean().optional(),
        answered: z.boolean().optional(),
        larger_than: z.number().int().positive().optional().describe('Size in bytes.'),
        smaller_than: z.number().int().positive().optional().describe('Size in bytes.'),
        keyword: z.string().optional().describe('Custom flag / keyword that must be set.'),
        header: z
          .record(z.string(), z.string())
          .optional()
          .describe('Header name -> substring, e.g. {"List-Id": "example"}.'),
        limit: z.number().int().min(1).max(200).default(20),
        offset: z.number().int().min(0).default(0),
      },
      annotations: READ_ONLY,
    },
    handler(async (args) =>
      accounts.withMailbox(args.account, args.mailbox, false, async (client) => {
        const query: SearchObject = {};
        if (args.text) query.text = args.text;
        if (args.from) query.from = args.from;
        if (args.to) query.to = args.to;
        if (args.cc) query.cc = args.cc;
        if (args.subject) query.subject = args.subject;
        if (args.body) query.body = args.body;
        if (args.since) query.since = args.since.slice(0, 10);
        if (args.before) query.before = args.before.slice(0, 10);
        if (args.seen !== undefined) query.seen = args.seen;
        if (args.flagged !== undefined) query.flagged = args.flagged;
        if (args.answered !== undefined) query.answered = args.answered;
        if (args.larger_than) query.larger = args.larger_than;
        if (args.smaller_than) query.smaller = args.smaller_than;
        if (args.keyword) query.keyword = args.keyword;
        if (args.header && Object.keys(args.header).length) query.header = args.header;
        if (Object.keys(query).length === 0) query.all = true;

        const result = await client.search(query, { uid: true });
        const uids = (result || []).sort((a, b) => b - a);
        const page = uids.slice(args.offset, args.offset + args.limit);
        return json({
          mailbox: args.mailbox,
          totalMatches: uids.length,
          offset: args.offset,
          hasMore: args.offset + page.length < uids.length,
          messages: await fetchSummaries(client, args.mailbox, page),
        });
      }),
    ),
  );

  server.registerTool(
    'get_message',
    {
      title: 'Get message',
      description:
        'Fetches a single message: headers, decoded body and the list of attachments (with part ids for get_attachment, ' +
        'which returns PDF, Word, Excel and other documents as text). ' +
        'HTML-only messages are converted to plain text unless format is "html" or "both". Does not mark the message as read.',
      inputSchema: {
        account: accountArg,
        mailbox: mailboxArg,
        uid: z.number().int().positive(),
        format: z.enum(['text', 'html', 'both']).default('text'),
        max_chars: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Maximum body length in characters (default ${config.maxBodyChars}).`),
        include_headers: z.boolean().default(false).describe('Include all raw headers.'),
      },
      outputSchema: messageOutput,
      annotations: READ_ONLY,
    },
    handler(async ({ account, mailbox, uid, format, max_chars, include_headers }) =>
      accounts.withMailbox(account, mailbox, false, async (client, acc) => {
        const msg = await client.fetchOne(
          String(uid),
          {
            ...SUMMARY_QUERY,
            headers: include_headers ? true : ['references', 'reply-to', 'list-unsubscribe', 'list-id', 'in-reply-to'],
          },
          { uid: true },
        );
        if (!msg) throw new ToolError(`Message UID ${uid} not found in "${mailbox}".`);

        const maxChars = max_chars ?? config.maxBodyChars;
        const { text, html, attachments } = analyzeStructure(msg.bodyStructure);
        const byteLimit = maxChars * 4;
        const textPart = text ? await downloadPart(client, uid, text.part!, byteLimit) : undefined;
        const htmlPart = html && (format !== 'text' || !textPart) ? await downloadPart(client, uid, html.part!, byteLimit) : undefined;

        const body: Record<string, unknown> = {};
        let truncated = false;
        const put = (key: string, value: string, partial: boolean) => {
          const t = truncate(value, maxChars);
          body[key] = t.text;
          truncated ||= t.truncated || partial;
        };
        if (format !== 'html') {
          if (textPart) put('text', textPart.data.toString('utf8'), textPart.truncated);
          else if (htmlPart) put('text', htmlToPlain(htmlPart.data.toString('utf8')), htmlPart.truncated);
        }
        if (format !== 'text' && htmlPart) put('html', htmlPart.data.toString('utf8'), htmlPart.truncated);

        const headers = parseHeaders(msg.headers);
        const env = msg.envelope ?? {};
        const uidValidity = uidValidityOf(client);
        let downloadExpiresAt: string | undefined;
        const attachmentList = attachments.map((a) => {
          const link = linker?.({ account: acc.name, mailbox, uid, part: a.part, uidValidity, filename: a.filename });
          downloadExpiresAt ??= link?.expiresAt;
          const { kind } = detectKind(a.contentType, a.filename);
          return {
            ...a,
            textAvailable: isTextDocument(a.contentType, a.filename) || (kind === 'image' && imageOcr),
            resourceUri: resourceUri(acc.name, mailbox, uid, a.part),
            ...(link ? { downloadUrl: link.url } : {}),
          };
        });
        return structured({
          ...summarize(msg, mailbox),
          bcc: formatAddresses(env.bcc),
          replyTo: formatAddresses(env.replyTo),
          inReplyTo: env.inReplyTo,
          references: headers['references']?.join(' '),
          listUnsubscribe: headers['list-unsubscribe']?.[0],
          ...(include_headers ? { headers } : {}),
          body,
          bodyTruncated: truncated,
          attachments: attachmentList,
          downloadExpiresAt,
        });
      }),
    ),
  );
}
