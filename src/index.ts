#!/usr/bin/env node
import { ConfigError, helpText, loadBaseConfig, loadConfig, parseArgs } from './config.js';

async function runStdio(argv: string[]): Promise<void> {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { createServer } = await import('./server.js');
  const config = loadConfig(argv);
  const { server, accounts } = createServer(config);

  const shutdown = async () => {
    await accounts.closeAll().catch(() => undefined);
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);

  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `[mcp-imap] running in ${config.mode} mode with account(s): ${config.accounts.map((a) => a.name).join(', ')}\n`,
  );
}

async function runHttp(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.configPath) throw new ConfigError('--config is not used by "serve"; accounts are managed per user in the web UI.');
  const { loadHttpConfig } = await import('./http/config.js');
  const { startHttpServer } = await import('./http/app.js');
  const config = loadHttpConfig(loadBaseConfig(args));
  const { close } = await startHttpServer(config);
  const shutdown = async () => {
    await close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;
  if (command === 'user' || command === 'users') {
    const { userCommand } = await import('./cli/users.js');
    return userCommand(rest);
  }
  const options = command === 'serve' || command === 'stdio' ? rest : argv;
  if (parseArgs(options).help) {
    process.stdout.write(helpText());
    return;
  }
  return command === 'serve' ? runHttp(options) : runStdio(options);
}

main().catch((err) => {
  const message = err instanceof ConfigError ? err.message : ((err as Error)?.stack ?? String(err));
  process.stderr.write(`[mcp-imap] ${message}\n`);
  process.exit(1);
});
