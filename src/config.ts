import { readFileSync } from 'node:fs';

export type Mode = 'read-only' | 'read-write';

export interface ImapSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  tlsRejectUnauthorized: boolean;
}

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
  tlsRejectUnauthorized: boolean;
  /** Append a copy of every sent message to the "Sent" mailbox. */
  saveToSent: boolean;
}

export interface AccountConfig {
  name: string;
  imap: ImapSettings;
  smtp?: SmtpSettings;
  /** Forces this account into read-only mode even if the server runs in read-write mode. */
  readOnly: boolean;
}

export interface ServerConfig {
  mode: Mode;
  allowSend: boolean;
  accounts: AccountConfig[];
  maxBodyChars: number;
  maxAttachmentBytes: number;
}

export class ConfigError extends Error {}

const HELP = `mcp-imap - MCP server for IMAP mailboxes

Usage:
  mcp-imap [options]                 Run as local stdio server (single user, accounts from env/config)
  mcp-imap serve [options]           Run as Streamable HTTP server with OAuth login and user backend
  mcp-imap user add <username>       Create a user for the HTTP server (password is prompted)
  mcp-imap user passwd <username>    Change a user's password
  mcp-imap user delete <username>    Delete a user and all stored data
  mcp-imap user list                 List users

Options:
  --read-only            Start in read-only mode (default). No write tools are exposed
                         and mailboxes are opened with EXAMINE.
  --read-write           Start in read-write mode. Exposes tools to flag, move, copy,
                         delete messages, manage mailboxes, save drafts and send mail.
  --mode <mode>          Same as above: "read-only" or "read-write".
  --no-send              In read-write mode, do not expose the send_email tool.
  --config <file>        JSON file with one or more accounts (see README).
  -h, --help             Show this help.

Environment (single account, used when no --config is given):
  IMAP_HOST, IMAP_PORT (993), IMAP_SECURE (true), IMAP_USER, IMAP_PASSWORD,
  IMAP_TLS_REJECT_UNAUTHORIZED (true), IMAP_ACCOUNT_NAME (default)
  SMTP_HOST, SMTP_PORT (465), SMTP_SECURE (true), SMTP_USER, SMTP_PASSWORD,
  SMTP_FROM, SMTP_SAVE_TO_SENT (true)
  MCP_IMAP_MODE, MCP_IMAP_CONFIG, MCP_IMAP_ALLOW_SEND (true),
  MCP_IMAP_MAX_BODY_CHARS (50000), MCP_IMAP_MAX_ATTACHMENT_BYTES (10485760)

Environment (HTTP server, "serve"):
  MCP_IMAP_PUBLIC_URL (https://... as seen by clients), MCP_IMAP_SECRET_KEY (required),
  MCP_IMAP_HTTP_HOST (127.0.0.1), MCP_IMAP_HTTP_PORT (3000), MCP_IMAP_TLS_CERT, MCP_IMAP_TLS_KEY,
  MCP_IMAP_DB (./data/mcp-imap.db), MCP_IMAP_ALLOW_REGISTRATION (false), MCP_IMAP_TRUST_PROXY (false),
  MCP_IMAP_ACCESS_TOKEN_TTL (3600), MCP_IMAP_REFRESH_TOKEN_TTL (2592000)
`;

export function helpText(): string {
  return HELP;
}

function parseBool(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new ConfigError(`Invalid boolean for ${name}: ${String(value)}`);
}

function parseInt10(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`Invalid number for ${name}: ${String(value)}`);
  }
  return n;
}

function parseMode(value: string, source: string): Mode {
  const v = value.trim().toLowerCase().replace(/[_\s]/g, '-');
  if (v === 'read-only' || v === 'readonly' || v === 'ro') return 'read-only';
  if (v === 'read-write' || v === 'readwrite' || v === 'rw') return 'read-write';
  throw new ConfigError(`Invalid mode "${value}" from ${source}. Use "read-only" or "read-write".`);
}

/** Resolves a secret that is either given inline or via the name of an environment variable. */
function secret(obj: Record<string, unknown>, key: string, env: NodeJS.ProcessEnv, ctx: string): string | undefined {
  const envKey = obj[`${key}Env`];
  if (typeof envKey === 'string' && envKey) {
    const value = env[envKey];
    if (value === undefined) throw new ConfigError(`${ctx}: environment variable ${envKey} is not set`);
    return value;
  }
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ConfigError(`Missing required setting: ${name}`);
  return value.trim();
}

function buildImap(raw: Record<string, unknown>, env: NodeJS.ProcessEnv, ctx: string): ImapSettings {
  const secure = parseBool(raw.secure, true, `${ctx}.secure`);
  const password = secret(raw, 'password', env, ctx);
  return {
    host: requireString(raw.host, `${ctx}.host`),
    port: parseInt10(raw.port, secure ? 993 : 143, `${ctx}.port`),
    secure,
    user: requireString(raw.user, `${ctx}.user`),
    password: requireString(password, `${ctx}.password`),
    tlsRejectUnauthorized: parseBool(raw.tlsRejectUnauthorized, true, `${ctx}.tlsRejectUnauthorized`),
  };
}

function buildSmtp(
  raw: Record<string, unknown> | undefined,
  imap: ImapSettings,
  env: NodeJS.ProcessEnv,
  ctx: string,
): SmtpSettings | undefined {
  if (!raw || !raw.host) return undefined;
  const secure = parseBool(raw.secure, true, `${ctx}.secure`);
  const user = typeof raw.user === 'string' && raw.user ? raw.user : imap.user;
  const password = secret(raw, 'password', env, ctx) ?? imap.password;
  return {
    host: requireString(raw.host, `${ctx}.host`),
    port: parseInt10(raw.port, secure ? 465 : 587, `${ctx}.port`),
    secure,
    user,
    password,
    from: typeof raw.from === 'string' && raw.from ? raw.from : user,
    tlsRejectUnauthorized: parseBool(raw.tlsRejectUnauthorized, true, `${ctx}.tlsRejectUnauthorized`),
    saveToSent: parseBool(raw.saveToSent, true, `${ctx}.saveToSent`),
  };
}

function accountsFromFile(path: string, env: NodeJS.ProcessEnv): AccountConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Cannot read config file ${path}: ${(err as Error).message}`);
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { accounts?: unknown })?.accounts;
  if (!Array.isArray(list) || list.length === 0) {
    throw new ConfigError(`Config file ${path} must contain a non-empty "accounts" array`);
  }
  const names = new Set<string>();
  return list.map((entry, i) => {
    const raw = (entry ?? {}) as Record<string, unknown>;
    const name = typeof raw.name === 'string' && raw.name ? raw.name : `account${i + 1}`;
    if (names.has(name)) throw new ConfigError(`Duplicate account name "${name}" in ${path}`);
    names.add(name);
    const imap = buildImap((raw.imap ?? {}) as Record<string, unknown>, env, `accounts[${name}].imap`);
    return {
      name,
      imap,
      smtp: buildSmtp(raw.smtp as Record<string, unknown> | undefined, imap, env, `accounts[${name}].smtp`),
      readOnly: parseBool(raw.readOnly, false, `accounts[${name}].readOnly`),
    };
  });
}

function accountFromEnv(env: NodeJS.ProcessEnv): AccountConfig {
  const imap = buildImap(
    {
      host: env.IMAP_HOST,
      port: env.IMAP_PORT,
      secure: env.IMAP_SECURE,
      user: env.IMAP_USER,
      password: env.IMAP_PASSWORD,
      tlsRejectUnauthorized: env.IMAP_TLS_REJECT_UNAUTHORIZED,
    },
    env,
    'IMAP',
  );
  const smtp = buildSmtp(
    {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      from: env.SMTP_FROM,
      tlsRejectUnauthorized: env.SMTP_TLS_REJECT_UNAUTHORIZED ?? env.IMAP_TLS_REJECT_UNAUTHORIZED,
      saveToSent: env.SMTP_SAVE_TO_SENT,
    },
    imap,
    env,
    'SMTP',
  );
  return { name: env.IMAP_ACCOUNT_NAME || 'default', imap, smtp, readOnly: false };
}

export interface CliArgs {
  help: boolean;
  mode?: Mode;
  configPath?: string;
  noSend: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false, noSend: false };
  const setMode = (mode: Mode) => {
    if (args.mode && args.mode !== mode) throw new ConfigError('Conflicting mode arguments');
    args.mode = mode;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined) throw new ConfigError(`Missing value for ${flag}`);
      return next;
    };
    switch (flag) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--read-only':
      case '--readonly':
        setMode('read-only');
        break;
      case '--read-write':
      case '--write':
        setMode('read-write');
        break;
      case '--mode':
        setMode(parseMode(value(), '--mode'));
        break;
      case '--config':
        args.configPath = value();
        break;
      case '--no-send':
        args.noSend = true;
        break;
      default:
        throw new ConfigError(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

export interface BaseConfig {
  mode: Mode;
  allowSend: boolean;
  maxBodyChars: number;
  maxAttachmentBytes: number;
}

/** Settings shared by the stdio and the HTTP server. */
export function loadBaseConfig(args: CliArgs, env: NodeJS.ProcessEnv = process.env): BaseConfig {
  return {
    // Read-only is the safe default; write access has to be requested explicitly.
    mode: args.mode ?? (env.MCP_IMAP_MODE ? parseMode(env.MCP_IMAP_MODE, 'MCP_IMAP_MODE') : 'read-only'),
    allowSend: !args.noSend && parseBool(env.MCP_IMAP_ALLOW_SEND, true, 'MCP_IMAP_ALLOW_SEND'),
    maxBodyChars: parseInt10(env.MCP_IMAP_MAX_BODY_CHARS, 50_000, 'MCP_IMAP_MAX_BODY_CHARS'),
    maxAttachmentBytes: parseInt10(env.MCP_IMAP_MAX_ATTACHMENT_BYTES, 10 * 1024 * 1024, 'MCP_IMAP_MAX_ATTACHMENT_BYTES'),
  };
}

export function loadConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const args = parseArgs(argv);
  const configPath = args.configPath ?? env.MCP_IMAP_CONFIG;
  const accounts = configPath ? accountsFromFile(configPath, env) : [accountFromEnv(env)];
  return { ...loadBaseConfig(args, env), accounts };
}
