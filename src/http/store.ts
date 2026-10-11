import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AccountConfig, ImapSettings, SmtpSettings } from '../config.js';
import { hashPassword, hashToken, randomToken, SecretBox, verifyPassword } from './crypto.js';

export interface User {
  id: number;
  username: string;
  created_at: number;
}

export interface MailAccountSettings {
  imap: ImapSettings;
  smtp?: SmtpSettings;
  readOnly: boolean;
}

export interface MailAccount {
  id: number;
  name: string;
  settings: MailAccountSettings;
}

export interface AuthRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource: string;
}

export interface AuthCode extends AuthRequest {
  userId: number;
}

export interface Grant {
  id: number;
  user_id: number;
  client_id: string;
  scopes: string[];
  resource: string;
  created_at: number;
  last_used_at: number | null;
}

export interface TokenRecord {
  grant: Grant;
  expiresAt: number;
}

export const MIN_PASSWORD_LENGTH = 10;

const now = () => Math.floor(Date.now() / 1000);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mail_accounts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, name)
);
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_requests (
  id_hash TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_codes (
  code_hash TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS grants (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id INTEGER NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tokens_grant ON tokens(grant_id);
CREATE TABLE IF NOT EXISTS web_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
`;

type Row = Record<string, unknown>;

export class Store {
  readonly db: DatabaseSync;
  private readonly box?: SecretBox;

  constructor(path: string, secretKey?: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    if (secretKey) this.box = new SecretBox(secretKey);
  }

  close(): void {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Removes expired rows. */
  cleanup(): void {
    const t = now();
    this.db.prepare('DELETE FROM auth_requests WHERE expires_at < ?').run(t);
    this.db.prepare('DELETE FROM auth_codes WHERE expires_at < ?').run(t);
    this.db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(t);
    this.db.prepare('DELETE FROM web_sessions WHERE expires_at < ?').run(t);
    // Grants without any remaining token are dead.
    this.db.prepare('DELETE FROM grants WHERE id NOT IN (SELECT DISTINCT grant_id FROM tokens)').run();
  }

  // ---- users -------------------------------------------------------------------------------

  async createUser(username: string, password: string): Promise<User> {
    const name = username.trim();
    if (!/^[A-Za-z0-9._@+-]{2,100}$/.test(name)) {
      throw new Error('Username must be 2-100 characters: letters, digits and . _ @ + -');
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
    }
    if (this.findUser(name)) throw new Error(`User "${name}" already exists.`);
    const hash = await hashPassword(password);
    const result = this.db
      .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
      .run(name, hash, now());
    return this.getUser(Number(result.lastInsertRowid))!;
  }

  findUser(username: string): User | undefined {
    return this.db.prepare('SELECT id, username, created_at FROM users WHERE username = ?').get(username.trim()) as
      | User
      | undefined;
  }

  getUser(id: number): User | undefined {
    return this.db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(id) as User | undefined;
  }

  listUsers(): User[] {
    return this.db.prepare('SELECT id, username, created_at FROM users ORDER BY username').all() as unknown as User[];
  }

  countUsers(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as Row).n);
  }

  async authenticate(username: string, password: string): Promise<User | undefined> {
    const row = this.db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(username.trim()) as
      | { id: number; password_hash: string }
      | undefined;
    // Verify against a dummy hash for unknown users to keep the timing similar.
    const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
    return row && ok ? this.getUser(row.id) : undefined;
  }

  async setPassword(userId: number, password: string): Promise<void> {
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
    }
    const hash = await hashPassword(password);
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
  }

  deleteUser(userId: number): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }

  // ---- mail accounts -----------------------------------------------------------------------

  private secretBox(): SecretBox {
    if (!this.box) throw new Error('Secret key is required to access mail account data.');
    return this.box;
  }

  listMailAccounts(userId: number): MailAccount[] {
    const rows = this.db
      .prepare('SELECT id, name, data FROM mail_accounts WHERE user_id = ? ORDER BY id')
      .all(userId) as { id: number; name: string; data: string }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      settings: JSON.parse(this.secretBox().decrypt(row.data, `mail_account:${userId}`)) as MailAccountSettings,
    }));
  }

  getMailAccount(userId: number, id: number): MailAccount | undefined {
    return this.listMailAccounts(userId).find((a) => a.id === id);
  }

  saveMailAccount(userId: number, id: number | undefined, name: string, settings: MailAccountSettings): number {
    const data = this.secretBox().encrypt(JSON.stringify(settings), `mail_account:${userId}`);
    try {
      if (id === undefined) {
        const result = this.db
          .prepare('INSERT INTO mail_accounts (user_id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(userId, name, data, now(), now());
        return Number(result.lastInsertRowid);
      }
      const result = this.db
        .prepare('UPDATE mail_accounts SET name = ?, data = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(name, data, now(), id, userId);
      if (result.changes === 0) throw new Error('Mail account not found.');
      return id;
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) throw new Error(`An account named "${name}" already exists.`);
      throw err;
    }
  }

  deleteMailAccount(userId: number, id: number): void {
    this.db.prepare('DELETE FROM mail_accounts WHERE id = ? AND user_id = ?').run(id, userId);
  }

  accountConfigs(userId: number): AccountConfig[] {
    return this.listMailAccounts(userId).map((a) => ({ name: a.name, ...a.settings }));
  }

  // ---- OAuth clients -----------------------------------------------------------------------

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db.prepare('SELECT data FROM oauth_clients WHERE client_id = ?').get(clientId) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as OAuthClientInformationFull) : undefined;
  }

  saveClient(client: OAuthClientInformationFull): void {
    this.db
      .prepare('INSERT OR REPLACE INTO oauth_clients (client_id, data, created_at) VALUES (?, ?, ?)')
      .run(client.client_id, JSON.stringify(client), now());
  }

  // ---- authorization requests & codes -------------------------------------------------------

  createAuthRequest(request: AuthRequest, ttl = 600): string {
    const id = randomToken(24);
    this.db
      .prepare('INSERT INTO auth_requests (id_hash, data, expires_at) VALUES (?, ?, ?)')
      .run(hashToken(id), JSON.stringify(request), now() + ttl);
    return id;
  }

  getAuthRequest(id: string): AuthRequest | undefined {
    const row = this.db
      .prepare('SELECT data FROM auth_requests WHERE id_hash = ? AND expires_at >= ?')
      .get(hashToken(id), now()) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as AuthRequest) : undefined;
  }

  deleteAuthRequest(id: string): void {
    this.db.prepare('DELETE FROM auth_requests WHERE id_hash = ?').run(hashToken(id));
  }

  createAuthCode(code: AuthCode, ttl = 300): string {
    const value = randomToken(32);
    this.db
      .prepare('INSERT INTO auth_codes (code_hash, data, expires_at) VALUES (?, ?, ?)')
      .run(hashToken(value), JSON.stringify(code), now() + ttl);
    return value;
  }

  getAuthCode(code: string): AuthCode | undefined {
    const row = this.db
      .prepare('SELECT data FROM auth_codes WHERE code_hash = ? AND expires_at >= ?')
      .get(hashToken(code), now()) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as AuthCode) : undefined;
  }

  /** Returns and deletes the code atomically, so a code can only be redeemed once. */
  consumeAuthCode(code: string): AuthCode | undefined {
    return this.tx(() => {
      const found = this.getAuthCode(code);
      if (found) this.db.prepare('DELETE FROM auth_codes WHERE code_hash = ?').run(hashToken(code));
      return found;
    });
  }

  // ---- grants & tokens ---------------------------------------------------------------------

  createGrant(userId: number, clientId: string, scopes: string[], resource: string): number {
    const result = this.db
      .prepare('INSERT INTO grants (user_id, client_id, scopes, resource, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, clientId, scopes.join(' '), resource, now());
    return Number(result.lastInsertRowid);
  }

  private grantFromRow(row: Row): Grant {
    return {
      id: Number(row.id),
      user_id: Number(row.user_id),
      client_id: String(row.client_id),
      scopes: String(row.scopes).split(' ').filter(Boolean),
      resource: String(row.resource),
      created_at: Number(row.created_at),
      last_used_at: row.last_used_at === null ? null : Number(row.last_used_at),
    };
  }

  issueTokens(grantId: number, accessTtl: number, refreshTtl: number) {
    const access = randomToken(32);
    const refresh = randomToken(32);
    const insert = this.db.prepare('INSERT INTO tokens (token_hash, grant_id, kind, expires_at) VALUES (?, ?, ?, ?)');
    this.tx(() => {
      insert.run(hashToken(access), grantId, 'access', now() + accessTtl);
      insert.run(hashToken(refresh), grantId, 'refresh', now() + refreshTtl);
    });
    return { access, refresh };
  }

  findToken(token: string, kind: 'access' | 'refresh'): TokenRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT g.*, t.expires_at AS token_expires_at FROM tokens t JOIN grants g ON g.id = t.grant_id
         WHERE t.token_hash = ? AND t.kind = ? AND t.expires_at >= ?`,
      )
      .get(hashToken(token), kind, now()) as Row | undefined;
    if (!row) return undefined;
    return { grant: this.grantFromRow(row), expiresAt: Number(row.token_expires_at) };
  }

  /** Atomically deletes a refresh token; returns false if it was already used (rotation). */
  consumeRefreshToken(token: string): boolean {
    const result = this.db.prepare("DELETE FROM tokens WHERE token_hash = ? AND kind = 'refresh'").run(hashToken(token));
    return result.changes > 0;
  }

  touchGrant(grantId: number, scopes?: string[]): void {
    if (scopes) {
      this.db.prepare('UPDATE grants SET last_used_at = ?, scopes = ? WHERE id = ?').run(now(), scopes.join(' '), grantId);
    } else {
      this.db.prepare('UPDATE grants SET last_used_at = ? WHERE id = ?').run(now(), grantId);
    }
  }

  /** Revokes the grant that a token belongs to (all its access and refresh tokens). */
  revokeByToken(token: string, clientId: string): void {
    const row = this.db
      .prepare('SELECT g.id FROM tokens t JOIN grants g ON g.id = t.grant_id WHERE t.token_hash = ? AND g.client_id = ?')
      .get(hashToken(token), clientId) as { id: number } | undefined;
    if (row) this.db.prepare('DELETE FROM grants WHERE id = ?').run(row.id);
  }

  listGrants(userId: number): (Grant & { client_name?: string })[] {
    const rows = this.db
      .prepare(
        `SELECT g.*, c.data AS client_data FROM grants g LEFT JOIN oauth_clients c ON c.client_id = g.client_id
         WHERE g.user_id = ? AND EXISTS (SELECT 1 FROM tokens t WHERE t.grant_id = g.id AND t.expires_at >= ?)
         ORDER BY g.created_at DESC`,
      )
      .all(userId, now()) as Row[];
    return rows.map((row) => ({
      ...this.grantFromRow(row),
      client_name: row.client_data ? (JSON.parse(String(row.client_data)) as OAuthClientInformationFull).client_name : undefined,
    }));
  }

  deleteGrant(userId: number, grantId: number): void {
    this.db.prepare('DELETE FROM grants WHERE id = ? AND user_id = ?').run(grantId, userId);
  }

  // ---- web sessions ------------------------------------------------------------------------

  createSession(userId: number, ttl = 7 * 24 * 3600): string {
    const id = randomToken(32);
    this.db
      .prepare('INSERT INTO web_sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(hashToken(id), userId, now() + ttl);
    return id;
  }

  sessionUser(id: string): User | undefined {
    const row = this.db
      .prepare('SELECT user_id FROM web_sessions WHERE id_hash = ? AND expires_at >= ?')
      .get(hashToken(id), now()) as { user_id: number } | undefined;
    return row ? this.getUser(row.user_id) : undefined;
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM web_sessions WHERE id_hash = ?').run(hashToken(id));
  }

  deleteSessionsOfUser(userId: number, exceptId?: string): void {
    this.db
      .prepare('DELETE FROM web_sessions WHERE user_id = ? AND id_hash != ?')
      .run(userId, exceptId ? hashToken(exceptId) : '');
  }
}

// scrypt hash of a random password, used to equalize timing for unknown users.
const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64, 1).toString('base64');
