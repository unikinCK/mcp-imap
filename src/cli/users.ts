import { createInterface } from 'node:readline';
import { ConfigError } from '../config.js';
import { Store } from '../http/store.js';

/** Reads a password from the terminal without echoing it, or the first line of stdin when piped. */
async function readPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) {
      rl.close();
      return line;
    }
    return '';
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const output = rl as unknown as { _writeToOutput: (s: string) => void };
    let prompted = false;
    output._writeToOutput = (s: string) => {
      if (!prompted) {
        process.stderr.write(s);
        prompted = true;
      }
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}

async function newPassword(): Promise<string> {
  const password = await readPassword('Password: ');
  if (process.stdin.isTTY) {
    const repeat = await readPassword('Repeat password: ');
    if (password !== repeat) throw new ConfigError('Passwords do not match.');
  }
  return password;
}

export async function userCommand(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const [action, username] = args;
  const store = new Store(env.MCP_IMAP_DB || './data/mcp-imap.db');
  try {
    switch (action) {
      case 'add': {
        if (!username) throw new ConfigError('Usage: mcp-imap user add <username>');
        const user = await store.createUser(username, await newPassword());
        process.stderr.write(`User "${user.username}" created.\n`);
        break;
      }
      case 'passwd': {
        const user = username ? store.findUser(username) : undefined;
        if (!user) throw new ConfigError(`User "${username ?? ''}" not found.`);
        await store.setPassword(user.id, await newPassword());
        store.deleteSessionsOfUser(user.id);
        process.stderr.write(`Password of "${user.username}" changed.\n`);
        break;
      }
      case 'delete': {
        const user = username ? store.findUser(username) : undefined;
        if (!user) throw new ConfigError(`User "${username ?? ''}" not found.`);
        store.deleteUser(user.id);
        process.stderr.write(`User "${user.username}" and all stored data deleted.\n`);
        break;
      }
      case 'list':
        for (const user of store.listUsers()) {
          process.stdout.write(`${user.username}\t${new Date(user.created_at * 1000).toISOString()}\n`);
        }
        break;
      default:
        throw new ConfigError('Usage: mcp-imap user <add|passwd|delete|list> [username]');
    }
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError((err as Error).message);
  } finally {
    store.close();
  }
}
