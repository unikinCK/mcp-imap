#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, helpText, loadConfig, parseArgs } from './config.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (parseArgs(argv).help) {
    process.stdout.write(helpText());
    return;
  }
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

main().catch((err) => {
  const message = err instanceof ConfigError ? err.message : (err as Error)?.stack ?? String(err);
  process.stderr.write(`[mcp-imap] ${message}\n`);
  process.exit(1);
});
