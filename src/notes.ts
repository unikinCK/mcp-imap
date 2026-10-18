import type { ImapFlow } from 'imapflow';
import libmime from 'libmime';
import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { AccountConfig } from './config.js';
import { resolveFolder } from './folders.js';
import { ToolError } from './imap.js';

/** A rule or reminder on how to handle the messages of one mailbox. */
export interface Note {
  /** UID in the notes folder; changes when the note is updated. */
  id: number;
  title: string;
  text: string;
  /** Folder the note applies to; undefined = the whole mailbox. */
  folder?: string;
  updated?: string;
  author?: string;
}

const SUBJECT_PREFIX = '[note] ';
const MAX_NOTES = 500;

/**
 * Stores notes as messages in a folder of the mailbox itself (default "MCP Notes"), so they work
 * with every server mode, travel with the mailbox and can be seen in any mail client.
 */
export class NotesStore {
  constructor(
    /** Folder name; undefined disables notes. */
    readonly folder: string | undefined,
    private readonly actor: string,
  ) {}

  get enabled(): boolean {
    return Boolean(this.folder);
  }

  /** All notes of the mailbox; with `folder`, only the general ones and those for that folder. */
  async list(client: ImapFlow, folder?: string): Promise<Note[]> {
    const path = await resolveFolder(client, this.folder!, false);
    if (!path) return [];
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      const exists = client.mailbox ? client.mailbox.exists : 0;
      if (!exists) return [];
      const from = Math.max(1, exists - MAX_NOTES + 1);
      const messages = await client.fetchAll(`${from}:*`, { uid: true, source: true, internalDate: true });
      const notes = await Promise.all(messages.map((m) => parseNote(m.uid, m.source!, m.internalDate)));
      return notes
        .filter((n): n is Note => Boolean(n))
        .filter((n) => !folder || !n.folder || n.folder.toLowerCase() === folder.toLowerCase())
        .sort((a, b) => (a.folder ?? '').localeCompare(b.folder ?? '') || a.title.localeCompare(b.title));
    } finally {
      lock.release();
    }
  }

  /** Saves a note; with `replaceId`, the old version is removed after the new one was stored. */
  async save(
    client: ImapFlow,
    account: AccountConfig,
    input: { title: string; text: string; folder?: string; replaceId?: number },
  ): Promise<{ note: Note; replaced?: Note }> {
    const path = (await resolveFolder(client, this.folder!, true))!;
    const replaced = input.replaceId ? await this.find(client, path, input.replaceId) : undefined;
    const address = account.imap.user.includes('@') ? account.imap.user : 'mcp-imap@localhost';
    const now = new Date();
    const raw = await new MailComposer({
      from: { name: 'mcp-imap notes', address },
      to: { name: account.name, address },
      subject: `${SUBJECT_PREFIX}${input.title}`,
      date: now,
      text: `${input.text.trim()}\n`,
      headers: {
        'X-MCP-IMAP-Note': '1',
        ...(input.folder ? { 'X-MCP-IMAP-Note-Folder': input.folder } : {}),
        'X-MCP-IMAP-Note-Author': this.actor,
      },
    })
      .compile()
      .build();
    const result = await client.append(path, raw, ['\\Seen'], now);
    if (!result) throw new ToolError(`Could not store the note in "${path}".`);
    if (replaced) await this.delete(client, path, replaced.id);
    return {
      note: { id: result.uid ?? 0, title: input.title, text: input.text.trim(), folder: input.folder, updated: now.toISOString(), author: this.actor },
      replaced,
    };
  }

  async remove(client: ImapFlow, id: number): Promise<Note> {
    const path = await resolveFolder(client, this.folder!, false);
    if (!path) throw new ToolError(`Note ${id} not found (there are no notes yet).`);
    const note = await this.find(client, path, id);
    await this.delete(client, path, id);
    return note;
  }

  private async find(client: ImapFlow, path: string, id: number): Promise<Note> {
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      const msg = await client.fetchOne(String(id), { uid: true, source: true, internalDate: true }, { uid: true });
      const note = msg ? await parseNote(msg.uid, msg.source!, msg.internalDate) : undefined;
      if (!note) throw new ToolError(`Note ${id} not found. get_notes lists the current ids.`);
      return note;
    } finally {
      lock.release();
    }
  }

  /** Notes are the server's own data, so removing one does not need the delete permission. */
  private async delete(client: ImapFlow, path: string, id: number): Promise<void> {
    const lock = await client.getMailboxLock(path);
    try {
      const ok = await client.messageDelete(String(id), { uid: true });
      if (!ok) throw new ToolError(`Could not remove note ${id}.`);
    } finally {
      lock.release();
    }
  }
}

async function parseNote(uid: number, source: Buffer, internalDate?: Date | string): Promise<Note | undefined> {
  const mail = await simpleParser(source, { skipHtmlToText: true, skipImageLinks: true, skipTextLinks: true });
  if (!mail.headers.has('x-mcp-imap-note')) return undefined;
  // mailparser leaves custom headers MIME-encoded (non-ASCII folder names).
  const header = (name: string) => {
    const value = mail.headers.get(name);
    return typeof value === 'string' && value ? libmime.decodeWords(value) : undefined;
  };
  const subject = mail.subject ?? '';
  const date = mail.date ?? (internalDate ? new Date(internalDate) : undefined);
  return {
    id: uid,
    title: subject.startsWith(SUBJECT_PREFIX) ? subject.slice(SUBJECT_PREFIX.length) : subject,
    text: (mail.text ?? '').trim(),
    folder: header('x-mcp-imap-note-folder'),
    updated: date?.toISOString(),
    author: header('x-mcp-imap-note-author'),
  };
}
