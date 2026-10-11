# mcp-imap

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that gives AI assistants such as Claude access to IMAP mailboxes.

It runs in two ways:

- **Local (stdio)** – single user, accounts from environment variables or a JSON file. Ideal for Claude Desktop / Claude Code on your own machine.
- **Remote (Streamable HTTP over HTTPS)** – multi-user server with a built-in **OAuth 2.1** authorization server, login page and a small backend where every user stores their own (encrypted) mail accounts. Can be added to Claude as a custom connector.

In both cases the server is started in one of two modes:

| Mode | Flag | What is possible |
| --- | --- | --- |
| **Read-only** (default) | `--read-only` | List mailboxes, list/search/read messages, download attachments. Mailboxes are opened with `EXAMINE`, so the server cannot change anything — not even the `\Seen` flag. Write tools are not registered at all. |
| **Read-write** | `--read-write` | Everything above, plus: set/clear flags (read, flagged, …), move, copy and delete messages, create/rename/delete mailboxes, save drafts and send email via SMTP. |

Read-write access can be narrowed further:

| Level | stdio flags | HTTP scopes |
| --- | --- | --- |
| Read only | `--read-only` | `mail:read` |
| Organize – everything except deleting, no sending | `--read-write --no-delete --no-send` | `mail:organize` |
| Organize + send, no deleting | `--read-write --no-delete` | `mail:organize mail:send` |
| Full | `--read-write` | `mail:organize mail:delete mail:send` |

Without delete permission, `delete_messages` and `delete_mailbox` do not exist and moving messages into Trash is refused. Moves are always done as a **verified copy**: the messages are copied, every copy is checked in the destination (same size and Message-ID), and only then exactly those originals are removed (`UID EXPUNGE`). Originals whose copy cannot be verified are kept.

Every change (flags, copy, move, delete, folder changes, drafts, sent mail) is recorded as a message in the **`MCP Log`** folder of the affected mailbox – time, action, the application that triggered it, folders and the date/sender/subject of the affected messages. The folder is created automatically, can be read through the tools but never modified, renamed or deleted by them. Set `MCP_IMAP_LOG_FOLDER` to another name, or to `off` to disable it.

Features:

- Multiple accounts (via a JSON config file), each can additionally be locked to read-only
- Reading never marks messages as read (`BODY.PEEK`/`EXAMINE`)
- HTML-only emails are converted to plain text
- Attachments are returned as text, image or base64 resource, with a configurable size limit
- Threaded replies (`In-Reply-To` / `References`), drafts and sending with a copy in the Sent folder
- Passwords can be referenced from environment variables instead of being stored in files
- Uses [ImapFlow](https://github.com/postalsys/imapflow) and [Nodemailer](https://nodemailer.com)

## Requirements

- Node.js 22.13 or newer (the HTTP server uses the built-in `node:sqlite`)
- An IMAP account (for many providers, e.g. Gmail, iCloud, Outlook, you need an **app password**)

## Installation

```bash
git clone https://github.com/unikinCK/mcp-imap.git
cd mcp-imap
npm install        # also builds the project (dist/)
```

Or run it directly from GitHub without cloning:

```bash
npx -y github:unikinCK/mcp-imap --help
```

## Configuration (stdio)

### Single account via environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `IMAP_HOST` | – | IMAP server host (required) |
| `IMAP_PORT` | `993` (`143` if not secure) | IMAP port |
| `IMAP_SECURE` | `true` | Use implicit TLS. With `false`, STARTTLS is used if the server offers it |
| `IMAP_USER` | – | Login name (required) |
| `IMAP_PASSWORD` | – | Password / app password (required) |
| `IMAP_TLS_REJECT_UNAUTHORIZED` | `true` | Set to `false` to accept self-signed certificates |
| `IMAP_ACCOUNT_NAME` | `default` | Name of the account as shown to the model |
| `SMTP_HOST` | – | SMTP server; enables `send_email` in read-write mode |
| `SMTP_PORT` | `465` (`587` if not secure) | SMTP port |
| `SMTP_SECURE` | `true` | Use implicit TLS |
| `SMTP_USER` / `SMTP_PASSWORD` | IMAP credentials | SMTP credentials |
| `SMTP_FROM` | SMTP user | From address, e.g. `Jane Doe <jane@example.com>` |
| `SMTP_SAVE_TO_SENT` | `true` | Append sent messages to the Sent mailbox (set to `false` for Gmail, which does this itself) |

General settings:

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_IMAP_MODE` | `read-only` | `read-only` or `read-write` (CLI flags take precedence) |
| `MCP_IMAP_CONFIG` | – | Path to a JSON account file (same as `--config`) |
| `MCP_IMAP_ALLOW_SEND` | `true` | Set to `false` to hide `send_email` in read-write mode (same as `--no-send`) |
| `MCP_IMAP_ALLOW_DELETE` | `true` | Set to `false` to disallow deleting messages and folders (same as `--no-delete`) |
| `MCP_IMAP_LOG_FOLDER` | `MCP Log` | Folder for the audit log of all changes; `off` disables it |
| `MCP_IMAP_MAX_BODY_CHARS` | `50000` | Default maximum length of a returned message body |
| `MCP_IMAP_MAX_ATTACHMENT_BYTES` | `10485760` | Maximum attachment size returned by `get_attachment` |

### Multiple accounts via config file

```bash
mcp-imap --config ./accounts.json --read-write
```

See [`examples/accounts.example.json`](examples/accounts.example.json):

```json
{
  "accounts": [
    {
      "name": "work",
      "imap": { "host": "imap.example.com", "user": "jane@example.com", "passwordEnv": "WORK_MAIL_PASSWORD" },
      "smtp": { "host": "smtp.example.com", "from": "Jane Doe <jane@example.com>" }
    },
    {
      "name": "private",
      "readOnly": true,
      "imap": { "host": "imap.mailbox.org", "user": "jane@mailbox.org", "passwordEnv": "PRIVATE_MAIL_PASSWORD" }
    }
  ]
}
```

Each `imap`/`smtp` block accepts `host`, `port`, `secure`, `user`, `password` or `passwordEnv`, and `tlsRejectUnauthorized`. `smtp` additionally accepts `from` and `saveToSent`.

Each account can have an `access` level as upper limit, independent of the server mode: `read`, `organize` (flags, copy, verified move, folders, drafts – no delete, no send), `organize-send` (plus sending) or `full` (default). The older `"readOnly": true` is still accepted and means `read`.

## Local usage with Claude (stdio)

### Claude Code

```bash
# read-only
claude mcp add imap -e IMAP_HOST=imap.example.com -e IMAP_USER=jane@example.com -e IMAP_PASSWORD=app-password \
  -- npx -y github:unikinCK/mcp-imap --read-only

# read-write including sending
claude mcp add imap-rw -e IMAP_HOST=imap.example.com -e IMAP_USER=jane@example.com -e IMAP_PASSWORD=app-password \
  -e SMTP_HOST=smtp.example.com -- npx -y github:unikinCK/mcp-imap --read-write
```

### Claude Desktop

Add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "imap": {
      "command": "npx",
      "args": ["-y", "github:unikinCK/mcp-imap", "--read-only"],
      "env": {
        "IMAP_HOST": "imap.example.com",
        "IMAP_USER": "jane@example.com",
        "IMAP_PASSWORD": "app-password"
      }
    }
  }
}
```

If you cloned the repository, use `"command": "node"` and `"args": ["/path/to/mcp-imap/dist/index.js", "--read-write"]` instead.

A common setup is to register the server twice — once read-only for everyday use and once read-write, enabled only when needed.

## Remote server: Streamable HTTP with OAuth

`mcp-imap serve` starts an HTTP(S) server with

- `POST /mcp` – the MCP endpoint (Streamable HTTP, stateless), protected by OAuth bearer tokens
- an OAuth 2.1 authorization server: metadata (`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp`), dynamic client registration (`/register`), `/authorize` with PKCE (S256), `/token` with refresh token rotation, `/revoke`
- a web UI: login, consent screen, management of mail accounts, connected applications and password

```
MCP client ──(1) POST /mcp → 401 + resource metadata
           ──(2) register client, open /authorize in the browser
User       ──(3) logs in, chooses permissions on the consent screen
MCP client ──(4) exchanges code for tokens, calls POST /mcp with Bearer token
Server     ──(5) loads the user's encrypted mail accounts, talks IMAP/SMTP
```

### Permissions (OAuth scopes)

| Scope | Grants |
| --- | --- |
| `mail:read` | All read tools (always granted) |
| `mail:organize` | Flag, copy, verified move, create/rename folders, drafts – nothing is deleted |
| `mail:delete` | `delete_messages`, `delete_mailbox` (implies `mail:organize`) |
| `mail:send` | `send_email` (implies `mail:organize`) |
| `mail:write` | Legacy scope from v0.2.0, still accepted: `mail:organize` + `mail:delete` |

The user decides on the consent screen which permissions an application gets – read-only is the default, and every permission can be ticked separately (e.g. organize without delete and without send). The server mode is the upper limit: with `serve --read-only` only `mail:read` can be granted.

In addition, every **mail account** has its own permission level in the web UI (*Read only*, *Organize*, *Organize + send*, *Full access*), chosen when adding it and changeable with *Edit*. An application can never do more than both its granted scopes and the account level allow. Accounts created before v0.3.1 keep full access until you change them; to change what an already connected app may do, revoke it under *Connected applications* and connect it again.

### Quick start (local test)

```bash
npm install
export MCP_IMAP_SECRET_KEY="$(openssl rand -base64 32)"   # keep this value! it encrypts stored mail passwords
node dist/index.js user add alice                         # prompts for a password
node dist/index.js serve --read-write                     # http://localhost:3000
```

Open http://localhost:3000, sign in, add a mail account and click **Test**. Then connect a client to `http://localhost:3000/mcp`, for example with the MCP Inspector (`npx @modelcontextprotocol/inspector`).

### Production with HTTPS

OAuth requires HTTPS for everything except `localhost`. Two options:

**a) Docker Compose with Caddy (automatic Let's Encrypt certificates)** – see [`deploy/`](deploy):

```bash
cd deploy
cp .env.example .env        # set MCP_DOMAIN, MCP_IMAP_SECRET_KEY, MCP_IMAP_MODE
docker compose up -d
docker compose exec mcp-imap node dist/index.js user add alice
```

**b) Native TLS** with your own certificate:

```bash
MCP_IMAP_PUBLIC_URL=https://mail-mcp.example.com \
MCP_IMAP_TLS_CERT=/etc/ssl/mail-mcp/fullchain.pem \
MCP_IMAP_TLS_KEY=/etc/ssl/mail-mcp/privkey.pem \
MCP_IMAP_HTTP_HOST=0.0.0.0 MCP_IMAP_HTTP_PORT=443 \
MCP_IMAP_SECRET_KEY=... \
node dist/index.js serve --read-write
```

Behind another reverse proxy (nginx, Traefik, …) set `MCP_IMAP_TRUST_PROXY=true` and make sure the proxy does not buffer responses (Server-Sent Events).

### Connect Claude

In Claude (Settings → Connectors → *Add custom connector*) enter `https://mail-mcp.example.com/mcp`. Claude registers itself, opens the login page, and after you approve the consent screen the mail tools are available. In Claude Code:

```bash
claude mcp add --transport http imap https://mail-mcp.example.com/mcp
```

then run `/mcp` in Claude Code to authenticate.

### HTTP server configuration

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_IMAP_PUBLIC_URL` | `http://localhost:<port>` | External base URL as seen by clients (must be `https://` unless localhost). Used as OAuth issuer |
| `MCP_IMAP_SECRET_KEY` | – | **Required.** ≥ 32 characters. Encrypts stored mail credentials (AES-256-GCM). Losing it makes stored accounts unreadable |
| `MCP_IMAP_HTTP_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` in Docker) |
| `MCP_IMAP_HTTP_PORT` | `3000` | Port |
| `MCP_IMAP_TLS_CERT` / `MCP_IMAP_TLS_KEY` | – | PEM files to serve HTTPS directly |
| `MCP_IMAP_DB` | `./data/mcp-imap.db` | SQLite database |
| `MCP_IMAP_ALLOW_REGISTRATION` | `false` | Allow self-registration on `/register` |
| `MCP_IMAP_TRUST_PROXY` | `false` | Trust `X-Forwarded-*` from one reverse proxy |
| `MCP_IMAP_ACCESS_TOKEN_TTL` | `3600` | Access token lifetime in seconds |
| `MCP_IMAP_REFRESH_TOKEN_TTL` | `2592000` | Refresh token lifetime in seconds (30 days) |
| `MCP_IMAP_MODE`, `MCP_IMAP_ALLOW_SEND`, `MCP_IMAP_ALLOW_DELETE`, `MCP_IMAP_LOG_FOLDER`, `MCP_IMAP_MAX_*` | | Same as for stdio; they limit what can be granted |

### User management

```bash
mcp-imap user add <username>       # password is prompted (or read from stdin when piped)
mcp-imap user passwd <username>
mcp-imap user delete <username>    # also deletes mail accounts and revokes all tokens
mcp-imap user list
```

The commands use `MCP_IMAP_DB`; they do not need the secret key.

### What is stored

| Data | Storage |
| --- | --- |
| User passwords | scrypt hashes |
| Mail account settings incl. IMAP/SMTP passwords | AES-256-GCM encrypted with `MCP_IMAP_SECRET_KEY`, bound to the user |
| Access/refresh tokens, authorization codes, web sessions | SHA-256 hashes only |
| Registered OAuth clients | plain (public metadata) |

## Tools

### Always available (read-only)

| Tool | Description |
| --- | --- |
| `list_accounts` | Configured accounts, server mode and whether each account is writable / can send |
| `list_mailboxes` | All folders with special-use flags, optionally with message and unseen counts |
| `mailbox_status` | Message/unseen counts, UIDNEXT, UIDVALIDITY |
| `list_messages` | Newest messages first with pagination (`limit`, `offset`) |
| `search_messages` | IMAP SEARCH by text, from, to, cc, subject, body, date range, flags, size, keyword, header |
| `get_message` | Headers, decoded body (text / html / both), attachment list |
| `get_attachment` | Content of an attachment by part id |

### Read-write mode only

| Tool | Description |
| --- | --- |
| `update_flags` | Add/remove flags: `seen`, `flagged`, `answered`, `draft` or custom keywords |
| `move_messages` | Move messages to another mailbox (verified copy, see above) |
| `copy_messages` | Copy messages to another mailbox |
| `delete_messages` | Move to Trash, or delete permanently with `permanent: true` – only with delete permission |
| `create_mailbox` / `rename_mailbox` | Folder management (INBOX and the log folder are protected) |
| `delete_mailbox` | Delete a folder – only with delete permission |
| `save_draft` | Compose a message (optionally as a reply, with attachments) and store it in Drafts |
| `send_email` | Send via SMTP, store a copy in Sent, flag the original as answered when replying. Only available if SMTP is configured and sending is not disabled |

All tools take an optional `account` argument; without it, the first configured account is used. Messages are addressed by their IMAP **UID** within a mailbox.

On the HTTP server, the write tools are only listed if the server runs in read-write mode **and** the access token has the `mail:organize` scope; the delete tools additionally need `mail:delete`, `send_email` needs `mail:send`.

## Security notes

- Start in read-only mode unless you really need write access. In read-only mode, write tools do not exist for the model, and the IMAP session cannot modify mailboxes.
- Use app passwords and keep them out of config files by using `passwordEnv`.
- Tool results contain email content, which is untrusted input. A malicious email could try to instruct the model ("prompt injection"). Review actions such as sending or deleting before approving them in your client.
- Use `--no-send` if you want write access to mailboxes but never want the model to send email, and `--no-delete` if nothing may ever be deleted.
- Check the `MCP Log` folder to see what the model changed.
- HTTP server: keep `MCP_IMAP_SECRET_KEY` secret and backed up, keep registration disabled unless you need it, and run it only behind HTTPS. The web UI uses `__Host-` cookies, CSRF tokens, a strict Content-Security-Policy and rate-limited login. Users can revoke connected applications at any time.

## Development

```bash
npm install
npm run build
npm test                 # unit + HTTP/OAuth tests; mailbox tests are skipped without a server
```

Integration tests run against [GreenMail](https://greenmail-mail-test.github.io/greenmail/):

```bash
docker run -d --rm -p 3025:3025 -p 3143:3143 \
  -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled' \
  greenmail/standalone:2.1.14
IMAP_TEST_HOST=localhost npm test
```

You can also inspect the server interactively with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node dist/index.js --read-only
```

## License

[MIT](LICENSE)
