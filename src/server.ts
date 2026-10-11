import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerConfig } from './config.js';
import { AccountManager, type ConnectionPool } from './imap.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';
import { VERSION } from './version.js';

export interface CreateServerOptions {
  pool?: ConnectionPool;
  noAccountsHint?: string;
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
          'Reading never marks messages as seen.'
        : 'IMAP mailbox access in READ-WRITE mode. Besides reading, messages can be flagged, copied and moved ' +
          '(verified copy), folders created and renamed and drafts saved' +
          (config.allowDelete ? '; messages and folders can be deleted' : '; deleting is NOT permitted') +
          (config.allowSend ? '; emails can be sent' : '') +
          '. Confirm destructive actions and outgoing emails with the user first.' +
          (config.logFolder ? ` Every change is recorded in the "${config.logFolder}" folder of the mailbox (read-only for you).` : ''),
    },
  );
  registerReadTools(server, accounts, config);
  // Write tools only exist if at least one mailbox may be changed.
  if (!readOnly && accounts.list().some((a) => accounts.isWritable(a.name))) registerWriteTools(server, accounts, config);
  return { server, accounts };
}
