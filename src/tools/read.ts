import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchObject } from 'imapflow';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
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
import { accountArg, handler, json, mailboxArg } from './common.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const dateArg = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, 'Use YYYY-MM-DD')
  .optional();

export function registerReadTools(server: McpServer, accounts: AccountManager, config: ServerConfig): void {
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
          writable: accounts.isWritable(a.name),
          canDelete: accounts.isWritable(a.name) && config.allowDelete,
          canSend: accounts.isWritable(a.name) && config.allowSend && Boolean(a.smtp),
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
        'Fetches a single message: headers, decoded body and the list of attachments (with part ids for get_attachment). ' +
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
      annotations: READ_ONLY,
    },
    handler(async ({ account, mailbox, uid, format, max_chars, include_headers }) =>
      accounts.withMailbox(account, mailbox, false, async (client) => {
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
        return json({
          ...summarize(msg, mailbox),
          bcc: formatAddresses(env.bcc),
          replyTo: formatAddresses(env.replyTo),
          inReplyTo: env.inReplyTo,
          references: headers['references']?.join(' '),
          listUnsubscribe: headers['list-unsubscribe']?.[0],
          ...(include_headers ? { headers } : {}),
          body,
          bodyTruncated: truncated,
          attachments,
        });
      }),
    ),
  );

  server.registerTool(
    'get_attachment',
    {
      title: 'Get attachment',
      description:
        'Downloads one attachment / body part of a message by its part id (see get_message). ' +
        'Text is returned as text, images as image content, everything else as a base64 embedded resource.',
      inputSchema: {
        account: accountArg,
        mailbox: mailboxArg,
        uid: z.number().int().positive(),
        part: z.string().regex(/^[0-9]+(\.[0-9]+)*$/, 'Part id like "2" or "1.2"'),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ account, mailbox, uid, part }) =>
      accounts.withMailbox(account, mailbox, false, async (client, acc) => {
        const limit = config.maxAttachmentBytes;
        const { meta, data, truncated } = await downloadPart(client, uid, part, limit);
        if (truncated) {
          throw new ToolError(
            `Attachment is larger than the configured limit of ${limit} bytes (MCP_IMAP_MAX_ATTACHMENT_BYTES).`,
          );
        }
        const mimeType = (meta.contentType || 'application/octet-stream').toLowerCase();
        const filename = meta.filename;
        const info = { uid, mailbox, part, filename, contentType: mimeType, size: data.length };
        if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType.endsWith('+xml')) {
          return {
            content: [
              { type: 'text', text: JSON.stringify(info) },
              { type: 'text', text: data.toString('utf8') },
            ],
          };
        }
        if (/^image\/(png|jpe?g|gif|webp)$/.test(mimeType)) {
          return {
            content: [
              { type: 'text', text: JSON.stringify(info) },
              { type: 'image', data: data.toString('base64'), mimeType },
            ],
          };
        }
        const uri = `imap://${encodeURIComponent(acc.name)}/${encodeURIComponent(mailbox)}/${uid}/${part}${
          filename ? `/${encodeURIComponent(filename)}` : ''
        }`;
        return {
          content: [
            { type: 'text', text: JSON.stringify(info) },
            { type: 'resource', resource: { uri, mimeType, blob: data.toString('base64') } },
          ],
        };
      }),
    ),
  );
}
