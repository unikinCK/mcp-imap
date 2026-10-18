import type { ImapFlow } from 'imapflow';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { AccountConfig } from './config.js';
import { isFolder, resolveFolder } from './folders.js';
import { ToolError } from './imap.js';
import { formatAddresses } from './messages.js';

export interface AuditMessage {
  uid: number;
  date?: string;
  from?: string;
  subject?: string;
}

export interface AuditEntry {
  /** Tool name, e.g. "move_messages". */
  action: string;
  /** One-line summary, used as subject of the log message. */
  summary: string;
  mailbox?: string;
  messages?: AuditMessage[];
  details?: Record<string, unknown>;
}

const MAX_LISTED_MESSAGES = 100;

/**
 * Writes an audit trail of all changing actions as messages into a folder of the affected
 * mailbox (default "MCP Log"). The folder can be read through the tools but never modified.
 */
export class AuditLog {
  private readonly resolved = new WeakMap<ImapFlow, string>();

  constructor(
    /** Folder name; undefined disables logging. */
    readonly folder: string | undefined,
    /** Who performs the actions, e.g. "Claude (user christoph)". */
    private readonly actor: string,
    /** Folder with the mailbox notes, which only the notes tools may change. */
    private readonly notesFolder?: string,
  ) {}

  get enabled(): boolean {
    return Boolean(this.folder);
  }

  /** True if the path is the log folder, which must not be modified through the tools. */
  isLogFolder(client: ImapFlow, path: string | undefined): boolean {
    return isFolder(client, this.folder, path);
  }

  /** Rejects the audit log folder and the notes folder as source or target of generic tools. */
  assertNotProtected(client: ImapFlow, ...paths: (string | undefined)[]): void {
    for (const path of paths) {
      if (this.isLogFolder(client, path)) {
        throw new ToolError(`"${path}" is the audit log folder. It can be read but not modified through this server.`);
      }
      if (isFolder(client, this.notesFolder, path)) {
        throw new ToolError(`"${path}" holds the mailbox notes. Change them with save_note and delete_note.`);
      }
    }
  }

  /** Finds the existing log folder or creates it. */
  private async resolve(client: ImapFlow): Promise<string> {
    const cached = this.resolved.get(client);
    if (cached) return cached;
    const path = (await resolveFolder(client, this.folder!, true))!;
    this.resolved.set(client, path);
    return path;
  }

  /** Appends a log entry. Returns a warning instead of throwing, so logging never breaks the action itself. */
  async write(client: ImapFlow, account: AccountConfig, entry: AuditEntry): Promise<{ logFolder?: string; logWarning?: string }> {
    if (!this.folder) return {};
    try {
      const path = await this.resolve(client);
      const address = account.imap.user.includes('@') ? account.imap.user : 'mcp-imap@localhost';
      const now = new Date();
      const lines = [
        `Time:    ${now.toISOString()}`,
        `Action:  ${entry.action}`,
        `Account: ${account.name} (${account.imap.user})`,
        `Actor:   ${this.actor}`,
      ];
      if (entry.mailbox) lines.push(`Mailbox: ${entry.mailbox}`);
      lines.push('', entry.summary);
      if (entry.messages?.length) {
        lines.push('', `Messages (${entry.messages.length}):`);
        for (const m of entry.messages.slice(0, MAX_LISTED_MESSAGES)) {
          lines.push(`  - UID ${m.uid} | ${m.date ?? '?'} | ${m.from ?? '?'} | ${m.subject ?? '(no subject)'}`);
        }
        if (entry.messages.length > MAX_LISTED_MESSAGES) lines.push(`  … and ${entry.messages.length - MAX_LISTED_MESSAGES} more`);
      }
      if (entry.details && Object.keys(entry.details).length) {
        lines.push('', 'Details:');
        for (const [key, value] of Object.entries(entry.details)) {
          if (value === undefined) continue;
          lines.push(`  ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
        }
      }
      const raw = await new MailComposer({
        from: { name: 'mcp-imap', address },
        to: { name: account.name, address },
        subject: `[mcp-imap] ${entry.summary}`,
        date: now,
        text: `${lines.join('\n')}\n`,
        headers: { 'X-MCP-IMAP-Action': entry.action, 'X-MCP-IMAP-Actor': this.actor },
      })
        .compile()
        .build();
      const result = await client.append(path, raw, ['\\Seen'], now);
      if (!result) return { logWarning: `Could not write the audit log entry to "${path}".` };
      return { logFolder: path };
    } catch (err) {
      return { logWarning: `Could not write the audit log entry: ${(err as Error).message}` };
    }
  }
}

/** Collects date/sender/subject of messages in the currently selected mailbox, for the audit log. */
export async function describeMessages(client: ImapFlow, uids: number[]): Promise<AuditMessage[]> {
  if (!uids.length) return [];
  const messages = await client.fetchAll(uids.join(','), { uid: true, envelope: true, internalDate: true }, { uid: true });
  return messages.map((m) => {
    const date = m.envelope?.date ?? m.internalDate;
    return {
      uid: m.uid,
      date: date ? new Date(date).toISOString().slice(0, 16).replace('T', ' ') : undefined,
      from: formatAddresses(m.envelope?.from)?.join(', '),
      subject: m.envelope?.subject,
    };
  });
}
