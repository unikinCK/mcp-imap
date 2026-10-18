import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AttachmentLinker } from './attachments.js';
import type { ServerConfig } from './config.js';
import { AccountManager, type ConnectionPool } from './imap.js';
import { registerAttachmentTools } from './tools/attachments.js';
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
          'Reading never marks messages as seen.' + ATTACHMENT_HINT
        : 'IMAP mailbox access in READ-WRITE mode. Besides reading, messages can be flagged, copied and moved ' +
          '(verified copy), folders created and renamed and drafts saved' +
          (config.allowDelete ? '; messages and folders can be deleted' : '; deleting is NOT permitted') +
          (config.allowSend ? '; emails can be sent' : '') +
          '. Confirm destructive actions and outgoing emails with the user first.' +
          (config.logFolder ? ` Every change is recorded in the "${config.logFolder}" folder of the mailbox (read-only for you).` : '') +
          ATTACHMENT_HINT,
    },
  );
  registerReadTools(server, accounts, config, options.attachmentLinker);
  registerAttachmentTools(server, accounts, config, options.attachmentLinker);
  // Write tools only exist if at least one mailbox may be changed.
  if (!readOnly && accounts.list().some((a) => accounts.isWritable(a.name))) registerWriteTools(server, accounts, config);
  return { server, accounts };
}
