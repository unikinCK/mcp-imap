import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import cors from 'cors';
import express, { type Express } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ServerConfig } from '../config.js';
import { ConnectionPool } from '../imap.js';
import { createServer } from '../server.js';
import type { HttpConfig } from './config.js';
import { downloadLinker, downloadRouter } from './download.js';
import { grantableScopes, ImapOAuthProvider, permissions, SCOPES } from './oauth.js';
import { Store } from './store.js';
import { webRouter } from './web.js';

const POOL_IDLE_MS = 5 * 60 * 1000;

export interface HttpApp {
  app: Express;
  store: Store;
  close(): Promise<void>;
}

export function createHttpApp(config: HttpConfig, store = new Store(config.dbPath, config.secretKey)): HttpApp {
  const provider = new ImapOAuthProvider(store, config);
  const mcpUrl = new URL('/mcp', config.publicUrl);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpUrl);

  // IMAP connections are kept per user for a few minutes so that consecutive requests are fast.
  const pools = new Map<number, ConnectionPool>();
  const poolFor = (userId: number) => {
    let pool = pools.get(userId);
    if (!pool) {
      pool = new ConnectionPool();
      pools.set(userId, pool);
    }
    return pool;
  };
  const dropPool = (userId: number) => {
    const pool = pools.get(userId);
    pools.delete(userId);
    void pool?.closeAll();
  };
  const sweeper = setInterval(() => {
    for (const [userId, pool] of pools) {
      if (Date.now() - pool.lastUsed > POOL_IDLE_MS) dropPool(userId);
    }
  }, 60_000);
  const cleaner = setInterval(() => store.cleanup(), 10 * 60_000);
  sweeper.unref();
  cleaner.unref();

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // OAuth 2.1 authorization server: metadata, dynamic client registration, authorize, token, revoke.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.publicUrl,
      baseUrl: config.publicUrl,
      resourceServerUrl: mcpUrl,
      scopesSupported: grantableScopes(config),
      resourceName: 'mcp-imap',
    }),
  );

  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: [SCOPES.read],
    resourceMetadataUrl,
    expectedResource: mcpUrl,
  });

  const mcpCors = cors({
    origin: true,
    exposedHeaders: ['Mcp-Session-Id', 'WWW-Authenticate'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'Mcp-Session-Id', 'Mcp-Protocol-Version', 'Last-Event-ID'],
  });

  app.options('/mcp', mcpCors);
  app.post('/mcp', mcpCors, express.json({ limit: '30mb' }), bearer, async (req, res) => {
    const auth = req.auth!;
    const userId = Number(auth.extra?.userId);
    let server: ReturnType<typeof createServer>['server'] | undefined;
    try {
      const granted = permissions(auth.scopes);
      const canWrite = config.mode === 'read-write' && granted.organize;
      const client = store.getClient(auth.clientId);
      const user = store.getUser(userId);
      const serverConfig: ServerConfig = {
        mode: canWrite ? 'read-write' : 'read-only',
        allowSend: canWrite && config.allowSend && granted.send,
        allowDelete: canWrite && config.allowDelete && granted.delete,
        logFolder: config.logFolder,
        notesFolder: config.notesFolder,
        skillFile: config.skillFile,
        actor: `${client?.client_name || auth.clientId} (mcp-imap user ${user?.username ?? userId}, scopes: ${auth.scopes.join(' ')})`,
        accounts: store.accountConfigs(userId),
        maxBodyChars: config.maxBodyChars,
        maxAttachmentBytes: config.maxAttachmentBytes,
        extract: config.extract,
      };
      ({ server } = createServer(serverConfig, {
        pool: poolFor(userId),
        attachmentLinker: downloadLinker(config, userId),
        noAccountsHint: `No mail account configured. Add one at ${new URL('/account', config.publicUrl).href}`,
      }));
      // Stateless Streamable HTTP: one MCP server instance per request, scoped to the token's user and permissions.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server?.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      process.stderr.write(`[mcp-imap] /mcp error: ${(err as Error).stack ?? err}\n`);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });
  const methodNotAllowed: express.RequestHandler = (_req, res) => {
    res
      .status(405)
      .set('Allow', 'POST')
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server).' }, id: null });
  };
  app.get('/mcp', mcpCors, methodNotAllowed);
  app.delete('/mcp', mcpCors, methodNotAllowed);

  if (config.downloadLinks) app.use(downloadRouter({ config, store, poolFor }));
  app.use(webRouter({ store, config, onUserChanged: dropPool }));

  return {
    app,
    store,
    async close() {
      clearInterval(sweeper);
      clearInterval(cleaner);
      await Promise.all([...pools.keys()].map(async (id) => pools.get(id)?.closeAll()));
      pools.clear();
      store.close();
    },
  };
}

export async function startHttpServer(config: HttpConfig): Promise<{ server: Server; close(): Promise<void> }> {
  const httpApp = createHttpApp(config);
  const server = config.tls
    ? createHttpsServer({ cert: config.tls.cert, key: config.tls.key }, httpApp.app)
    : createHttpServer(httpApp.app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  const scheme = config.tls ? 'https' : 'http';
  process.stderr.write(
    `[mcp-imap] listening on ${scheme}://${config.host}:${config.port} (public URL ${config.publicUrl.href}, ${config.mode} mode)\n` +
      `[mcp-imap] MCP endpoint: ${new URL('/mcp', config.publicUrl).href}\n`,
  );
  if (httpApp.store.countUsers() === 0 && !config.allowRegistration) {
    process.stderr.write('[mcp-imap] No users yet. Create one with: mcp-imap user add <username>\n');
  }
  return {
    server,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await httpApp.close();
    },
  };
}
