import { readFileSync } from 'node:fs';
import { type BaseConfig, ConfigError, type ExtractConfig, type Mode } from '../config.js';

export interface HttpConfig {
  mode: Mode;
  allowSend: boolean;
  allowDelete: boolean;
  logFolder?: string;
  notesFolder?: string;
  skillFile?: string;
  publicUrl: URL;
  host: string;
  port: number;
  tls?: { cert: Buffer; key: Buffer };
  dbPath: string;
  secretKey: string;
  allowRegistration: boolean;
  trustProxy: boolean;
  accessTokenTtl: number;
  refreshTokenTtl: number;
  maxBodyChars: number;
  maxAttachmentBytes: number;
  maxBase64Bytes: number;
  extract: ExtractConfig;
  /** Signed, short-lived download links for attachments (GET /attachments/<token>). */
  downloadLinks: boolean;
  /** Validity of a download link in seconds. */
  downloadTtl: number;
}

function bool(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value === '') return fallback;
  const v = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new ConfigError(`Invalid boolean for ${name}: ${value}`);
}

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`Invalid number for ${name}: ${value}`);
  return n;
}

export function loadHttpConfig(
  base: BaseConfig,
  env: NodeJS.ProcessEnv = process.env,
): HttpConfig {
  const port = int(env.MCP_IMAP_HTTP_PORT, 3000, 'MCP_IMAP_HTTP_PORT');
  const certFile = env.MCP_IMAP_TLS_CERT;
  const keyFile = env.MCP_IMAP_TLS_KEY;
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new ConfigError('MCP_IMAP_TLS_CERT and MCP_IMAP_TLS_KEY must be set together.');
  }
  let tls: HttpConfig['tls'];
  if (certFile && keyFile) {
    try {
      tls = { cert: readFileSync(certFile), key: readFileSync(keyFile) };
    } catch (err) {
      throw new ConfigError(`Cannot read TLS certificate/key: ${(err as Error).message}`);
    }
  }

  const rawUrl = env.MCP_IMAP_PUBLIC_URL || `${tls ? 'https' : 'http'}://localhost:${port}`;
  let publicUrl: URL;
  try {
    publicUrl = new URL(rawUrl.replace(/\/+$/, ''));
  } catch {
    throw new ConfigError(`Invalid MCP_IMAP_PUBLIC_URL: ${rawUrl}`);
  }
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname);
  if (publicUrl.protocol !== 'https:' && !isLocal) {
    throw new ConfigError('MCP_IMAP_PUBLIC_URL must use https:// (OAuth requires HTTPS except for localhost).');
  }

  const secretKey = env.MCP_IMAP_SECRET_KEY ?? '';
  if (secretKey.length < 32) {
    throw new ConfigError(
      'MCP_IMAP_SECRET_KEY must be set to a random string of at least 32 characters ' +
        '(e.g. `openssl rand -base64 32`). It encrypts the stored mail passwords.',
    );
  }

  return {
    ...base,
    publicUrl,
    host: env.MCP_IMAP_HTTP_HOST || '127.0.0.1',
    port,
    tls,
    dbPath: env.MCP_IMAP_DB || './data/mcp-imap.db',
    secretKey,
    allowRegistration: bool(env.MCP_IMAP_ALLOW_REGISTRATION, false, 'MCP_IMAP_ALLOW_REGISTRATION'),
    trustProxy: bool(env.MCP_IMAP_TRUST_PROXY, false, 'MCP_IMAP_TRUST_PROXY'),
    accessTokenTtl: int(env.MCP_IMAP_ACCESS_TOKEN_TTL, 3600, 'MCP_IMAP_ACCESS_TOKEN_TTL'),
    refreshTokenTtl: int(env.MCP_IMAP_REFRESH_TOKEN_TTL, 30 * 24 * 3600, 'MCP_IMAP_REFRESH_TOKEN_TTL'),
    downloadLinks: bool(env.MCP_IMAP_DOWNLOAD_LINKS, true, 'MCP_IMAP_DOWNLOAD_LINKS'),
    downloadTtl: int(env.MCP_IMAP_DOWNLOAD_TTL, 600, 'MCP_IMAP_DOWNLOAD_TTL'),
  };
}
