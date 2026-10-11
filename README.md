# mcp-imap

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that gives AI assistants such as Claude access to IMAP mailboxes.

The server is started in one of two modes:

| Mode | Flag | What is possible |
| --- | --- | --- |
| **Read-only** (default) | `--read-only` | List mailboxes, list/search/read messages, download attachments. Mailboxes are opened with `EXAMINE`, so the server cannot change anything — not even the `\Seen` flag. Write tools are not registered at all. |
| **Read-write** | `--read-write` | Everything above, plus: set/clear flags (read, flagged, …), move, copy and delete messages, create/rename/delete mailboxes, save drafts and send email via SMTP. |

Features:

- Multiple accounts (via a JSON config file), each can additionally be locked to read-only
- Reading never marks messages as read (`BODY.PEEK`/`EXAMINE`)
- HTML-only emails are converted to plain text
- Attachments are returned as text, image or base64 resource, with a configurable size limit
- Threaded replies (`In-Reply-To` / `References`), drafts and sending with a copy in the Sent folder
- Passwords can be referenced from environment variables instead of being stored in files
- Uses [ImapFlow](https://github.com/postalsys/imapflow) and [Nodemailer](https://nodemailer.com)

## Requirements

- Node.js 20 or newer
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

## Configuration

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

Each `imap`/`smtp` block accepts `host`, `port`, `secure`, `user`, `password` or `passwordEnv`, and `tlsRejectUnauthorized`. `smtp` additionally accepts `from` and `saveToSent`. An account with `"readOnly": true` stays read-only even if the server runs with `--read-write`.

## Usage with Claude

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
| `move_messages` | Move messages to another mailbox |
| `copy_messages` | Copy messages to another mailbox |
| `delete_messages` | Move to Trash, or delete permanently with `permanent: true` |
| `create_mailbox` / `rename_mailbox` / `delete_mailbox` | Folder management (INBOX is protected) |
| `save_draft` | Compose a message (optionally as a reply, with attachments) and store it in Drafts |
| `send_email` | Send via SMTP, store a copy in Sent, flag the original as answered when replying. Only available if SMTP is configured and sending is not disabled |

All tools take an optional `account` argument; without it, the first configured account is used. Messages are addressed by their IMAP **UID** within a mailbox.

## Security notes

- Start in read-only mode unless you really need write access. In read-only mode, write tools do not exist for the model, and the IMAP session cannot modify mailboxes.
- Use app passwords and keep them out of config files by using `passwordEnv`.
- Tool results contain email content, which is untrusted input. A malicious email could try to instruct the model ("prompt injection"). Review actions such as sending or deleting before approving them in your client.
- Use `--no-send` if you want write access to mailboxes but never want the model to send email.

## Development

```bash
npm install
npm run build
npm test                 # unit tests; integration tests are skipped without a server
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
