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
| `MCP_IMAP_NOTES_FOLDER` | `MCP Notes` | Folder for the [mailbox notes](#mailbox-notes-and-instance-guide); `off` disables them |
| `MCP_IMAP_SKILL_FILE` | – | Markdown file with instructions for this instance, appended to `get_skill` |
| `MCP_IMAP_MAX_BODY_CHARS` | `50000` | Default maximum length of a returned message body |
| `MCP_IMAP_MAX_ATTACHMENT_BYTES` | `10485760` | Maximum attachment size returned by `get_attachment` |
| `MCP_IMAP_DOWNLOAD_DIR` | – | Enables `save_attachment`, which writes attachments into this local directory (stdio only) |

Settings for reading attachments as text (stdio and HTTP):

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_IMAP_EXTRACT_TIMEOUT` | `30` | Seconds one PDF / Word / Excel file may take to parse |
| `MCP_IMAP_EXTRACT_MEMORY_MB` | `512` | Heap limit of the extraction worker (protects against decompression bombs) |
| `MCP_IMAP_OCR` | `auto` | OCR for scanned PDFs and images when the optional packages are installed; `off` disables it |
| `MCP_IMAP_OCR_LANGS` | `deu+eng` | Tesseract languages. German and English are bundled; other languages are downloaded from the tesseract.js CDN unless `MCP_IMAP_OCR_LANG_PATH` is set |
| `MCP_IMAP_OCR_LANG_PATH` | – | Directory or URL with `<lang>.traineddata.gz` files |
| `MCP_IMAP_OCR_MAX_PAGES` | `10` | Scanned pages OCR'd per call (request more with `pages`) |
| `MCP_IMAP_OCR_TIMEOUT` | `180` | Seconds one OCR run may take |
| `MCP_IMAP_RENDER_MAX_PAGES` | `5` | PDF pages rendered per call with `format: "images"` |

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
| `mail:organize` | Flag, copy, verified move, create/rename folders, drafts, reply and forward drafts – nothing is deleted |
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
| `MCP_IMAP_DOWNLOAD_LINKS` | `true` | Signed download links for attachments (`/attachments/<token>`), see [Attachments](#attachments) |
| `MCP_IMAP_DOWNLOAD_TTL` | `600` | Validity of a download link in seconds |
| `MCP_IMAP_MODE`, `MCP_IMAP_ALLOW_SEND`, `MCP_IMAP_ALLOW_DELETE`, `MCP_IMAP_LOG_FOLDER`, `MCP_IMAP_MAX_*`, `MCP_IMAP_EXTRACT_*`, `MCP_IMAP_OCR*` | | Same as for stdio |

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
| `get_message` | Headers, decoded body (text / html / both), attachment list with `textAvailable`, `resourceUri` and (HTTP) `downloadUrl` |
| `get_attachment` | An attachment by part id: PDF, Word, Excel, attached e-mails, HTML and text as **plain text**; images, rendered PDF pages, the original file or just links on request (see [Attachments](#attachments)) |
| `save_attachment` | Save attachments of a message as files into `MCP_IMAP_DOWNLOAD_DIR` (stdio, only if configured) |
| `get_skill` | Guide to this instance: mailboxes and their permissions, workflows, rules and the instance instructions (also as resource `mcp-imap://skill` and prompt `mail_assistant`) |
| `get_notes` | Notes of a mailbox: rules on how to handle its messages (optionally only those for one folder) |

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
| `reply_message` | Reply like a mail client: recipient from Reply-To/From, `reply_all` (without your own addresses), `Re:` subject, threading headers, original quoted below (`>` / blockquote, header in English or German), optionally with the original attachments. Saved as draft by default; `send: true` sends it (needs send permission) and flags the original as answered |
| `forward_messages` | Forward one or more messages as a draft in Drafts – inline with all original attachments (incl. inline images) or as `.eml` attachment. Everything is copied on the server, so large PDFs work too |
| `save_note` / `delete_note` | Save, replace (`replace_id`) or delete a note of a mailbox |
| `send_email` | Send via SMTP, store a copy in Sent, flag the original as answered when replying. Only available if SMTP is configured and sending is not disabled |

`save_draft`, `send_email`, `reply_message` and `forward_messages` accept `attach_from_messages` (`[{ mailbox, uid, part? }]`) to reuse attachments of existing messages – copied on the server (max. 25 MB per draft), without passing file contents through the conversation.

All tools take an optional `account` argument; without it, the first configured account is used. Messages are addressed by their IMAP **UID** within a mailbox.

`get_message` and `get_attachment` also return `structuredContent` with a JSON output schema, so programs can read fields such as `downloadUrl`, `textInfo.nextOffset` or `kind` without parsing text.

On the HTTP server, the write tools are only listed if the server runs in read-write mode **and** the access token has the `mail:organize` scope; the delete tools additionally need `mail:delete`, `send_email` needs `mail:send`.

## Attachments

Every MCP client can show text, but support for images, embedded files and links differs between chat platforms, IDEs and automation tools. The server therefore does the work itself and offers several ways to get an attachment:

| `format` | Result | For |
| --- | --- | --- |
| `auto` (default) | Text for PDF, Word (`.docx`), Excel (`.xlsx`), attached e-mails (`.eml`), HTML, CSV and other text files. Images as image **plus** OCR text. Unknown types as base64 resource | Every chat client |
| `text` | Text only; fails if the type cannot be converted | Pipelines that only handle text |
| `raw` | Original file as base64 embedded resource (images as image) | Clients that handle embedded files |
| `images` | PDF pages rendered as PNG images (`pages`, max. `MCP_IMAP_RENDER_MAX_PAGES`) | Vision models, layouts, poor scans |
| `link` | Only metadata, `resource_link` and download link, without downloading the file | Large files, programs |

- **Detection by content:** PDFs and Office files are recognized by their content, also when the mail program sent them as `application/octet-stream`.
- **Long documents** come in chunks: `max_chars` (default `MCP_IMAP_MAX_BODY_CHARS`) and `offset`; the response contains `textInfo.nextOffset`. For PDFs, `pages: "2-4"` selects pages, and every page starts with `--- Page n of m ---`. Parsed documents are cached for 15 minutes, so paging does not parse the file again.
- **Scanned PDFs and images** have no text layer. Pages with almost no text are OCR'd with [tesseract.js](https://github.com/naptha/tesseract.js) (German and English bundled, at most `MCP_IMAP_OCR_MAX_PAGES` per call); `textInfo.ocrPages` lists them. OCR (`tesseract.js` with `@tesseract.js-data/deu` and `eng`), PDF rendering (`@napi-rs/canvas`) and pdf.js' standard fonts and CMaps (`pdfjs-dist`) are optional dependencies: if they are missing (e.g. `npm install --omit=optional`), text-layer PDFs still work and the response explains what is missing. The Docker image contains all of them.
- **Isolation:** files are parsed in a worker thread with a heap limit and a timeout, so a broken or malicious file cannot block or crash the server.
- **MCP resources:** every attachment has a URI `imap://{account}/{mailbox}/{uid}/{part}` that clients with resource support can read via `resources/read` (original file).
- **Download links (HTTP server):** `get_message` and `get_attachment` return a `downloadUrl` like `https://mail.example.com/attachments/<token>/Rechnung.pdf`. The signed token is the only credential, so code sandboxes, n8n, Zapier or `curl` can fetch the original file without the OAuth token. A link is valid for `MCP_IMAP_DOWNLOAD_TTL` seconds (10 minutes), works only for this one attachment of this user, stops working when the mailbox's UIDVALIDITY changes, and is served with `Content-Security-Policy: sandbox` and `nosniff`. Each download is written to the server log and, for writable mailboxes, to the `MCP Log` folder. Treat links like passwords while they are valid; disable them with `MCP_IMAP_DOWNLOAD_LINKS=false`.
- **Local files (stdio):** with `MCP_IMAP_DOWNLOAD_DIR=/path` the tool `save_attachment` saves all or selected attachments of a message into that directory (sanitized file names, existing files are never overwritten unless `overwrite: true`) and returns path, size and SHA-256 of each file.

## Mailbox notes and instance guide

**Notes** are rules and reminders on how the messages of one mailbox should be handled, e.g. "newsletters go to *95 Newsletter & Werbung*" or "invoices must be addressed to unikin GmbH". The model reads them with `get_notes` before working on a mailbox and stores new rules with `save_note` when the user states them. Notes are saved as messages in the `MCP Notes` folder **of that mailbox**:

- They apply to every client, every session and both server modes, and move with the mailbox.
- You can read them in any mail client.
- A note can apply to the whole mailbox or to one folder (`folder`).
- Only the notes tools can change the folder; `move_messages`, `update_flags` etc. reject it.
- Each change is written to the `MCP Log` folder.
- Saving and deleting needs write access to the mailbox (organize level); read-only clients can read notes.

**`get_skill`** returns a Markdown guide to the instance. It is built from the actual configuration (server mode, mailboxes with their access level, whether OCR, download links and notes are available) and lists workflows and rules. The content of `MCP_IMAP_SKILL_FILE` is appended as "Instructions for this instance". Use the file for house rules such as filing conventions or tone of replies. The file is read on every call, so changes apply without a restart. Clients that support MCP resources or prompts also get the guide as `mcp-imap://skill` and the prompt `mail_assistant`. The server instructions tell the model to call `get_skill` first.

## Security notes

- Start in read-only mode unless you really need write access. In read-only mode, write tools do not exist for the model, and the IMAP session cannot modify mailboxes.
- Use app passwords and keep them out of config files by using `passwordEnv`.
- Tool results contain email content, which is untrusted input. A malicious email could try to instruct the model ("prompt injection"). Review actions such as sending or deleting before approving them in your client.
- Use `--no-send` if you want write access to mailboxes but never want the model to send email, and `--no-delete` if nothing may ever be deleted.
- Check the `MCP Log` folder to see what the model changed.
- Attachment text is untrusted input as well. Documents are parsed in an isolated worker with time and memory limits; download links are short-lived capability URLs.
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
