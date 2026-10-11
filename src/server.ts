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
        : 'IMAP mailbox access in READ-WRITE mode. Besides reading, messages can be flagged, moved, copied and deleted, ' +
          'mailboxes managed, drafts saved and (if configured) emails sent. Confirm destructive actions and outgoing ' +
          'emails with the user first.',
    },
  );
  registerReadTools(server, accounts, config);
  if (!readOnly) registerWriteTools(server, accounts, config);
  return { server, accounts };
}
