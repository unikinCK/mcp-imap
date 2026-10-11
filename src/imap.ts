import { ImapFlow, type ListResponse } from 'imapflow';
import { type AccountConfig, levelAllows, type ServerConfig } from './config.js';

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
  key: string;
  client?: ImapFlow;
  mutex: Mutex;
}

/**
 * Holds IMAP connections per account. A pool can outlive a single AccountManager, which lets
 * the HTTP server reuse connections across requests of the same user.
 */
export class ConnectionPool {
  private readonly states = new Map<string, AccountState>();
  lastUsed = Date.now();

  state(account: AccountConfig): AccountState {
    this.lastUsed = Date.now();
    const key = JSON.stringify(account.imap);
    let state = this.states.get(account.name);
    if (state && state.key !== key) {
      // Settings changed: drop the old connection and start fresh.
      state.client?.close();
      state = undefined;
    }
    if (!state) {
      state = { config: account, key, mutex: new Mutex() };
      this.states.set(account.name, state);
    }
    state.config = account;
    return state;
  }

  async connect(state: AccountState): Promise<ImapFlow> {
    if (state.client?.usable) return state.client;
    state.client = undefined;
    const { imap } = state.config;
    const client = new ImapFlow({
      host: imap.host,
      port: imap.port,
      secure: imap.secure,
      auth: { user: imap.user, pass: imap.password },
      tls: { rejectUnauthorized: imap.tlsRejectUnauthorized },
      // stdout is the MCP transport in stdio mode, so imapflow must never log there.
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

  async closeAll(): Promise<void> {
    const states = [...this.states.values()];
    this.states.clear();
    await Promise.all(
      states.map(async (state) => {
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

export class AccountManager {
  private readonly accounts = new Map<string, AccountConfig>();

  constructor(
    private readonly config: ServerConfig,
    private readonly pool: ConnectionPool = new ConnectionPool(),
    private readonly noAccountsHint = 'No accounts configured.',
  ) {
    for (const account of config.accounts) this.accounts.set(account.name, account);
  }

  get serverReadOnly(): boolean {
    return this.config.mode === 'read-only';
  }

  list(): AccountConfig[] {
    return this.config.accounts;
  }

  get(name?: string): AccountConfig {
    if (!name) {
      const first = this.config.accounts[0];
      if (!first) throw new ToolError(this.noAccountsHint);
      return first;
    }
    const account = this.accounts.get(name);
    if (!account) {
      throw new ToolError(`Unknown account "${name}". Available: ${[...this.accounts.keys()].join(', ') || 'none'}`);
    }
    return account;
  }

  isWritable(name?: string): boolean {
    return !this.serverReadOnly && levelAllows(this.get(name).access, 'write');
  }

  canDelete(name?: string): boolean {
    return this.isWritable(name) && this.config.allowDelete && levelAllows(this.get(name).access, 'delete');
  }

  canSend(name?: string): boolean {
    const account = this.get(name);
    return this.isWritable(name) && this.config.allowSend && levelAllows(account.access, 'send') && Boolean(account.smtp);
  }

  assertWritable(name?: string): void {
    const account = this.get(name);
    if (this.serverReadOnly) throw new ToolError('Write access is not available (read-only mode or missing permission).');
    if (!levelAllows(account.access, 'write')) throw new ToolError(`Account "${account.name}" is set to read only.`);
  }

  assertCanDelete(name?: string): void {
    this.assertWritable(name);
    const account = this.get(name);
    if (!this.config.allowDelete) throw new ToolError('Deleting is not permitted.');
    if (!levelAllows(account.access, 'delete')) {
      throw new ToolError(`Deleting is not permitted for account "${account.name}" (access level "${account.access}").`);
    }
  }

  assertCanSend(name?: string): void {
    this.assertWritable(name);
    const account = this.get(name);
    if (!this.config.allowSend) throw new ToolError('Sending is not permitted.');
    if (!levelAllows(account.access, 'send')) {
      throw new ToolError(`Sending is not permitted for account "${account.name}" (access level "${account.access}").`);
    }
    if (!account.smtp) throw new ToolError(`Account "${account.name}" has no SMTP server configured.`);
  }

  /** Runs `fn` with a connected client for the given account. Operations on one account are serialized. */
  async withClient<T>(name: string | undefined, fn: (client: ImapFlow, account: AccountConfig) => Promise<T>): Promise<T> {
    const state = this.pool.state(this.get(name));
    return state.mutex.run(async () => {
      const client = await this.pool.connect(state);
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
    await this.pool.closeAll();
  }
}

/** Finds a mailbox by special-use flag such as "\\Trash", "\\Sent" or "\\Drafts". */
export async function findSpecialUse(client: ImapFlow, specialUse: string): Promise<ListResponse | undefined> {
  const list = await client.list();
  return list.find((box) => box.specialUse === specialUse);
}
