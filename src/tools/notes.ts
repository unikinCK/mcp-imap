import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AuditLog } from '../audit.js';
import type { ServerConfig } from '../config.js';
import type { AccountManager } from '../imap.js';
import { NotesStore } from '../notes.js';
import { accountArg, handler, structured } from './common.js';

const noteSchema = z.object({
  id: z.number().describe('Id for save_note (replace_id) and delete_note; changes when the note is updated.'),
  title: z.string(),
  text: z.string(),
  folder: z.string().optional().describe('Folder the note applies to; missing = the whole mailbox.'),
  updated: z.string().optional(),
  author: z.string().optional(),
});

const folderArg = z
  .string()
  .min(1)
  .optional()
  .describe('Folder the rule applies to, e.g. "INBOX". Leave out for rules that apply to the whole mailbox.');

/**
 * Notes are rules and reminders on how to handle the messages of one mailbox ("newsletters go to
 * 95 Newsletter & Werbung", "invoices must be addressed to unikin GmbH"). They are stored in a
 * folder of that mailbox, so every client and every session sees the same rules.
 */
export function registerNoteTools(server: McpServer, accounts: AccountManager, config: ServerConfig): void {
  if (!config.notesFolder) return;
  const actor = config.actor ?? 'unknown client';
  const store = new NotesStore(config.notesFolder, actor);
  const audit = new AuditLog(config.logFolder, actor, config.notesFolder);

  server.registerTool(
    'get_notes',
    {
      title: 'Get mailbox notes',
      description:
        'Returns the notes of a mailbox: rules and reminders, saved by the user or by you, on how its messages should be ' +
        'handled (where to file them, what to watch out for, how to answer). Read them before sorting, answering or ' +
        `cleaning up a mailbox and follow them. Stored in the "${config.notesFolder}" folder of the mailbox.`,
      inputSchema: {
        account: accountArg,
        folder: z.string().optional().describe('Only general notes and those for this folder.'),
      },
      outputSchema: { account: z.string(), notesFolder: z.string(), notes: z.array(noteSchema) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(async ({ account, folder }) =>
      accounts.withClient(account, async (client, acc) =>
        structured({ account: acc.name, notesFolder: config.notesFolder!, notes: await store.list(client, folder) }),
      ),
    ),
  );

  if (!accounts.list().some((a) => accounts.isWritable(a.name))) return;

  server.registerTool(
    'save_note',
    {
      title: 'Save mailbox note',
      description:
        'Saves a note for a mailbox: a lasting rule or reminder on how to handle its messages. Use it when the user states ' +
        'such a rule ("always move newsletters to …", "remember that …") or confirms a way of handling messages that ' +
        'should be repeated. One rule per note with a short title. To change a note, pass its id as replace_id. ' +
        'Do not store passwords or other secrets.',
      inputSchema: {
        account: accountArg,
        title: z.string().min(1).max(200).describe('Short title, e.g. "Newsletter".'),
        text: z.string().min(1).max(10_000).describe('The rule or reminder.'),
        folder: folderArg,
        replace_id: z.number().int().positive().optional().describe('Id of an existing note to replace.'),
      },
      outputSchema: { account: z.string(), note: noteSchema, replaced: noteSchema.optional(), logFolder: z.string().optional(), logWarning: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler(async ({ account, title, text, folder, replace_id }) => {
      accounts.assertWritable(account);
      return accounts.withClient(account, async (client, acc) => {
        const result = await store.save(client, acc, { title, text, folder, replaceId: replace_id });
        const log = await audit.write(client, acc, {
          action: 'save_note',
          summary: `${result.replaced ? 'Updated' : 'Saved'} note "${title}"${folder ? ` for ${folder}` : ''}`,
          details: { text, folder, replaced: result.replaced?.text },
        });
        return structured({ account: acc.name, ...result, ...log });
      });
    }),
  );

  server.registerTool(
    'delete_note',
    {
      title: 'Delete mailbox note',
      description: 'Deletes a note of a mailbox by its id (see get_notes). Only when the rule no longer applies or the user asks.',
      inputSchema: { account: accountArg, id: z.number().int().positive() },
      outputSchema: { account: z.string(), deleted: noteSchema, logFolder: z.string().optional(), logWarning: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handler(async ({ account, id }) => {
      accounts.assertWritable(account);
      return accounts.withClient(account, async (client, acc) => {
        const deleted = await store.remove(client, id);
        const log = await audit.write(client, acc, {
          action: 'delete_note',
          summary: `Deleted note "${deleted.title}"${deleted.folder ? ` for ${deleted.folder}` : ''}`,
          details: { text: deleted.text },
        });
        return structured({ account: acc.name, deleted, ...log });
      });
    }),
  );
}
