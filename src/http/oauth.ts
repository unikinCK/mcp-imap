import type { Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { HttpConfig } from './config.js';
import type { Store } from './store.js';

export const SCOPES = {
  read: 'mail:read',
  organize: 'mail:organize',
  delete: 'mail:delete',
  send: 'mail:send',
  /** Legacy (v0.2.0): organize + delete. Still accepted, no longer offered on the consent screen. */
  write: 'mail:write',
} as const;

export const SCOPE_DESCRIPTIONS: Record<string, string> = {
  [SCOPES.read]: 'Read mailboxes, messages and attachments',
  [SCOPES.organize]:
    'Organize without deleting: flag, copy and move messages (moves are verified before the original is removed), ' +
    'create and rename folders, save drafts',
  [SCOPES.delete]: 'Delete messages and folders',
  [SCOPES.send]: 'Send emails in your name',
};

/** Scopes shown on the consent screen, limited by the server mode. */
export function grantableScopes(config: HttpConfig): string[] {
  if (config.mode === 'read-only') return [SCOPES.read];
  const scopes: string[] = [SCOPES.read, SCOPES.organize];
  if (config.allowDelete) scopes.push(SCOPES.delete);
  if (config.allowSend) scopes.push(SCOPES.send);
  return scopes;
}

/** Scopes a client may request (grantable ones plus the legacy write scope). */
export function supportedScopes(config: HttpConfig): string[] {
  const scopes = grantableScopes(config);
  return config.mode === 'read-write' ? [...scopes, SCOPES.write] : scopes;
}

/** Expands legacy scopes and implications: delete and send both need organize. */
export function normalizeScopes(scopes: string[]): string[] {
  const set = new Set<string>([SCOPES.read, ...scopes]);
  if (set.has(SCOPES.write)) {
    set.delete(SCOPES.write);
    set.add(SCOPES.organize);
    set.add(SCOPES.delete);
  }
  if (set.has(SCOPES.delete) || set.has(SCOPES.send)) set.add(SCOPES.organize);
  const order: string[] = [SCOPES.read, SCOPES.organize, SCOPES.delete, SCOPES.send];
  return order.filter((s) => set.has(s));
}

/** Permissions of a token, taking legacy scopes into account. */
export function permissions(scopes: string[]) {
  const s = normalizeScopes(scopes);
  return { organize: s.includes(SCOPES.organize), delete: s.includes(SCOPES.delete), send: s.includes(SCOPES.send) };
}

function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/$/, '') === b.replace(/\/$/, '');
}

class ClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly store: Store) {}

  getClient(clientId: string) {
    return this.store.getClient(clientId);
  }

  registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) {
    const full = client as OAuthClientInformationFull;
    this.store.saveClient(full);
    return full;
  }
}

/**
 * OAuth 2.1 authorization server backed by the SQLite store. The interactive part (login and
 * consent) lives in web.ts; `authorize` only records the request and redirects there.
 */
export class ImapOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly resourceUrl: string;

  constructor(
    private readonly store: Store,
    private readonly config: HttpConfig,
  ) {
    this.clientsStore = new ClientsStore(store);
    this.resourceUrl = new URL('/mcp', config.publicUrl).href;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && !sameUrl(params.resource.href, this.resourceUrl)) {
      throw new InvalidTargetError(`Unknown resource ${params.resource.href}`);
    }
    const supported = supportedScopes(this.config);
    const unknown = (params.scopes ?? []).filter((s) => !supported.includes(s));
    if (unknown.length) throw new InvalidScopeError(`Unsupported scope(s): ${unknown.join(' ')}`);

    const id = this.store.createAuthRequest({
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      resource: this.resourceUrl,
    });
    res.redirect(302, `/oauth/consent?request=${encodeURIComponent(id)}`);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const code = this.store.getAuthCode(authorizationCode);
    if (!code || code.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
    return code.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const code = this.store.consumeAuthCode(authorizationCode);
    if (!code || code.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
    if (redirectUri && redirectUri !== code.redirectUri) throw new InvalidGrantError('redirect_uri does not match');
    if (resource && !sameUrl(resource.href, code.resource)) throw new InvalidTargetError('resource does not match');
    if (!this.store.getUser(code.userId)) throw new InvalidGrantError('User no longer exists');

    const grantId = this.store.createGrant(code.userId, client.client_id, code.scopes, code.resource);
    return this.tokens(grantId, code.scopes);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.store.findToken(refreshToken, 'refresh');
    if (!record || record.grant.client_id !== client.client_id) throw new InvalidGrantError('Invalid refresh token');
    if (resource && !sameUrl(resource.href, record.grant.resource)) throw new InvalidTargetError('resource does not match');
    let granted = record.grant.scopes;
    if (scopes?.length) {
      const extra = scopes.filter((s) => !granted.includes(s));
      if (extra.length) throw new InvalidScopeError(`Scope(s) not granted: ${extra.join(' ')}`);
      granted = scopes;
    }
    // Refresh tokens are single-use (rotation).
    if (!this.store.consumeRefreshToken(refreshToken)) throw new InvalidGrantError('Refresh token already used');
    this.store.touchGrant(record.grant.id, granted);
    return this.tokens(record.grant.id, granted);
  }

  private tokens(grantId: number, scopes: string[]): OAuthTokens {
    const { access, refresh } = this.store.issueTokens(grantId, this.config.accessTokenTtl, this.config.refreshTokenTtl);
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: this.config.accessTokenTtl,
      refresh_token: refresh,
      scope: scopes.join(' '),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.store.findToken(token, 'access');
    if (!record) throw new InvalidTokenError('Invalid or expired access token');
    return {
      token,
      clientId: record.grant.client_id,
      scopes: record.grant.scopes,
      expiresAt: record.expiresAt,
      resource: new URL(record.grant.resource),
      extra: { userId: record.grant.user_id, grantId: record.grant.id },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.store.revokeByToken(request.token, client.client_id);
  }
}
