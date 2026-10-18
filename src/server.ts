import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AttachmentLinker } from './attachments.js';
import type { ServerConfig } from './config.js';
import { AccountManager, type ConnectionPool } from './imap.js';
import { buildSkill } from './skill.js';
import { registerAttachmentTools } from './tools/attachments.js';
import { registerNoteTools } from './tools/notes.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';
import { VERSION } from './version.js';

export interface CreateServerOptions {
  pool?: ConnectionPool;
  noAccountsHint?: string;
  /** Creates download links for attachments (HTTP server only). */
  attachmentLinker?: AttachmentLinker;
}

const ATTACHMENT_HINT =
  ' Attachments (PDF, Word, Excel, attached e-mails, images) can be read as text with get_attachment; ' +
  'you do not need to download or parse files yourself.';

const SKILL_HINT = ' Call get_skill first for a guide to this server, its mailboxes and the instructions of this instance.';

function notesHint(config: ServerConfig): string {
  if (!config.notesFolder) return '';
  return (
    ' Each mailbox can have notes with rules on how to handle its messages: read them with get_notes before acting on a ' +
    'mailbox' +
    (config.mode === 'read-write' ? ', and save lasting rules the user states with save_note.' : '.')
  );
}

export function createServer(
  config: ServerConfig,
  options: CreateServerOptions = {},
): { server: McpServer; accounts: AccountManager } {
  const accounts = new AccountManager(config, options.pool, options.noAccountsHint);
  const readOnly = config.mode === 'read-only';
  const server = new McpServer(
    { name: 'mcp-imap', version: VERSION },
    {
      instructions: readOnly
        ? 'IMAP mailbox access in READ-ONLY mode. Messages can be listed, searched and read; nothing can be changed. ' +
          'Reading never marks messages as seen.' + ATTACHMENT_HINT + notesHint(config) + SKILL_HINT
        : 'IMAP mailbox access in READ-WRITE mode. Besides reading, messages can be flagged, copied and moved ' +
          '(verified copy), folders created and renamed and drafts saved' +
          (config.allowDelete ? '; messages and folders can be deleted' : '; deleting is NOT permitted') +
          (config.allowSend ? '; emails can be sent' : '') +
          '. Confirm destructive actions and outgoing emails with the user first.' +
          (config.logFolder ? ` Every change is recorded in the "${config.logFolder}" folder of the mailbox (read-only for you).` : '') +
          ATTACHMENT_HINT +
          notesHint(config) +
          SKILL_HINT,
    },
  );
  registerReadTools(server, accounts, config, options.attachmentLinker);
  registerAttachmentTools(server, accounts, config, options.attachmentLinker);
  registerNoteTools(server, accounts, config);
  registerSkill(server, () => buildSkill({ config, accounts, downloadLinks: Boolean(options.attachmentLinker) }));
  // Write tools only exist if at least one mailbox may be changed.
  if (!readOnly && accounts.list().some((a) => accounts.isWritable(a.name))) registerWriteTools(server, accounts, config);
  return { server, accounts };
}

/** The guide as tool (every client), resource and prompt (clients that support those). */
function registerSkill(server: McpServer, build: () => string): void {
  const description =
    'Guide to this mail server: what it can do with which mailbox, typical workflows, rules to follow and the ' +
    'instructions of this instance. Read it before working with the mailboxes.';
  server.registerTool(
    'get_skill',
    {
      title: 'How to use this mail server',
      description,
      inputSchema: {},
      outputSchema: { skill: z.string().describe('Markdown guide.') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const skill = build();
      return { content: [{ type: 'text', text: skill }], structuredContent: { skill } };
    },
  );
  server.registerResource('skill', 'mcp-imap://skill', { title: 'Mail server guide', description, mimeType: 'text/markdown' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: build() }],
  }));
  server.registerPrompt('mail_assistant', { title: 'Mail assistant', description }, () => ({
    messages: [{ role: 'user', content: { type: 'text', text: build() } }],
  }));
}
