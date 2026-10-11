import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ToolError } from '../imap.js';

export const accountArg = z
  .string()
  .optional()
  .describe('Account name as returned by list_accounts. Defaults to the first configured account.');

export const mailboxArg = z.string().default('INBOX').describe('Mailbox (folder) path, e.g. "INBOX" or "INBOX/Archive".');

export const uidsArg = z
  .array(z.number().int().positive())
  .min(1)
  .max(1000)
  .describe('Message UIDs within the mailbox (as returned by list_messages / search_messages).');

export function json(data: unknown): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2),
      },
    ],
  };
}

function describeError(err: unknown): string {
  if (err instanceof ToolError) return err.message;
  const e = err as { message?: string; responseText?: string; responseStatus?: string; authenticationFailed?: boolean };
  if (e?.authenticationFailed) return 'IMAP authentication failed. Check user name and password.';
  const parts = [e?.message ?? String(err)];
  if (e?.responseText && e.responseText !== e.message) parts.push(`Server response: ${e.responseText}`);
  return parts.join(' ');
}

/** Wraps a tool handler so that thrown errors are reported as tool errors instead of protocol errors. */
export function handler<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${describeError(err)}` }] };
    }
  };
}
