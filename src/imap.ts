import { ImapFlow, type ListResponse } from 'imapflow';
import type { AccountConfig, ServerConfig } from './config.js';

export class ToolError extends Error {}

/** Minimal promise-based mutex so that operations on one account never interleave. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

interface AccountState {
  config: AccountConfig;
  client?: ImapFlow;
  mutex: Mutex;
}

export class AccountManager {
  private readonly accounts = new Map<string, AccountState>();

  constructor(private readonly config: ServerConfig) {
    for (const account of config.accounts) {
      this.accounts.set(account.name, { config: account, mutex: new Mutex() });
    }
  }

  get serverReadOnly(): boolean {
    return this.config.mode === 'read-only';
  }

  list(): AccountConfig[] {
    return this.config.accounts;
  }

  get(name?: string): AccountConfig {
    return this.state(name).config;
  }

  isWritable(name?: string): boolean {
    return !this.serverReadOnly && !this.get(name).readOnly;
  }

  assertWritable(name?: string): void {
    const account = this.get(name);
    if (this.serverReadOnly) throw new ToolError('The server is running in read-only mode.');
    if (account.readOnly) throw new ToolError(`Account "${account.name}" is configured as read-only.`);
  }

  private state(name?: string): AccountState {
    if (!name) {
      const first = this.accounts.values().next().value;
      if (!first) throw new ToolError('No accounts configured.');
      return first;
    }
    const state = this.accounts.get(name);
    if (!state) {
      throw new ToolError(`Unknown account "${name}". Available: ${[...this.accounts.keys()].join(', ')}`);
    }
    return state;
  }

  private async connect(state: AccountState): Promise<ImapFlow> {
    if (state.client?.usable) return state.client;
    state.client = undefined;
    const { imap } = state.config;
    const client = new ImapFlow({
      host: imap.host,
      port: imap.port,
      secure: imap.secure,
      auth: { user: imap.user, pass: imap.password },
      tls: { rejectUnauthorized: imap.tlsRejectUnauthorized },
      // stdout is the MCP transport, so imapflow must never log there.
      logger: false,
      disableAutoIdle: true,
    });
    client.on('error', (err: Error) => {
      process.stderr.write(`[mcp-imap] ${state.config.name}: ${err.message}\n`);
    });
    client.on('close', () => {
      if (state.client === client) state.client = undefined;
    });
    await client.connect();
    state.client = client;
    return client;
  }

  /** Runs `fn` with a connected client for the given account. Operations on one account are serialized. */
  async withClient<T>(name: string | undefined, fn: (client: ImapFlow, account: AccountConfig) => Promise<T>): Promise<T> {
    const state = this.state(name);
    return state.mutex.run(async () => {
      const client = await this.connect(state);
      try {
        return await fn(client, state.config);
      } catch (err) {
        if (!client.usable && state.client === client) state.client = undefined;
        throw err;
      }
    });
  }

  /**
   * Opens a mailbox and runs `fn` while holding the mailbox lock. Mailboxes are opened with
   * EXAMINE (read-only) unless `write` is true, which additionally requires write access.
   */
  async withMailbox<T>(
    name: string | undefined,
    path: string,
    write: boolean,
    fn: (client: ImapFlow, account: AccountConfig) => Promise<T>,
  ): Promise<T> {
    if (write) this.assertWritable(name);
    return this.withClient(name, async (client, account) => {
      let lock;
      try {
        lock = await client.getMailboxLock(path, { readOnly: !write });
      } catch (err) {
        if ((err as { mailboxMissing?: boolean }).mailboxMissing) {
          throw new ToolError(`Mailbox "${path}" does not exist.`);
        }
        throw err;
      }
      try {
        return await fn(client, account);
      } finally {
        lock.release();
      }
    });
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.accounts.values()].map(async (state) => {
        const client = state.client;
        state.client = undefined;
        if (client?.usable) {
          try {
            await client.logout();
          } catch {
            client.close();
          }
        }
      }),
    );
  }
}

/** Finds a mailbox by special-use flag such as "\\Trash", "\\Sent" or "\\Drafts". */
export async function findSpecialUse(client: ImapFlow, specialUse: string): Promise<ListResponse | undefined> {
  const list = await client.list();
  return list.find((box) => box.specialUse === specialUse);
}
