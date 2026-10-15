// End-to-end test against a real IMAP/SMTP server (e.g. GreenMail).
// Skipped unless IMAP_TEST_HOST is set. Example:
//   docker run -d -p 3025:3025 -p 3143:3143 \
//     -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled' \
//     greenmail/standalone:2.1.14
//   IMAP_TEST_HOST=localhost npm test
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import nodemailer from 'nodemailer';

const host = process.env.IMAP_TEST_HOST;
const imapPort = process.env.IMAP_TEST_PORT ?? '3143';
const smtpPort = process.env.SMTP_TEST_PORT ?? '3025';
const user = `test-${Date.now()}@example.com`;
// Binary attachment with every byte value, to check that forwarding copies files byte-exact.
const BINARY = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) % 256));
const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const WRITE_TOOLS = [
  'update_flags',
  'move_messages',
  'copy_messages',
  'delete_messages',
  'create_mailbox',
  'rename_mailbox',
  'delete_mailbox',
  'save_draft',
  'forward_messages',
  'reply_message',
  'send_email',
];

async function startClient(args) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, ...args],
    env: {
      PATH: process.env.PATH ?? '',
      IMAP_HOST: host,
      IMAP_PORT: imapPort,
      IMAP_SECURE: 'false',
      IMAP_USER: user,
      IMAP_PASSWORD: 'secret',
      SMTP_HOST: host,
      SMTP_PORT: smtpPort,
      SMTP_SECURE: 'false',
      SMTP_FROM: `Test User <${user}>`,
    },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'integration-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed: ${result.content[0].text}`);
  return result;
}

async function callJson(client, name, args) {
  return JSON.parse((await call(client, name, args)).content[0].text);
}

async function seed() {
  const transport = nodemailer.createTransport({ host, port: Number(smtpPort), secure: false, ignoreTLS: true });
  await transport.sendMail({
    from: 'Alice <alice@example.com>',
    to: user,
    subject: 'Plain hello',
    text: 'Hello from Alice. Grüße!',
  });
  await transport.sendMail({
    from: 'Bob <bob@example.com>',
    to: user,
    subject: 'Report with attachment',
    html: '<p>See the <b>report</b> attached.</p>',
    attachments: [
      { filename: 'report.txt', content: 'quarterly numbers' },
      { filename: 'data.bin', content: BINARY, contentType: 'application/octet-stream' },
    ],
  });
  await transport.sendMail({
    from: 'Carol <carol@example.com>',
    replyTo: 'carol-replies@example.com',
    to: user,
    cc: 'Dave <dave@example.com>',
    subject: 'Question',
    text: 'Can you answer this?',
  });
  transport.close();
}

describe('integration', { skip: !host && 'IMAP_TEST_HOST not set' }, () => {
  before(async () => {
    await seed();
    await new Promise((r) => setTimeout(r, 500));
  });

  describe('read-only mode', () => {
    let client;
    before(async () => (client = await startClient(['--read-only'])));
    after(async () => client?.close());

    test('exposes no write tools', async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      for (const t of WRITE_TOOLS) assert.ok(!names.includes(t), `${t} must not be exposed`);
      assert.ok(names.includes('get_message'));
    });

    test('lists, searches and reads messages without marking them seen', async () => {
      const list = await callJson(client, 'list_messages', {});
      assert.equal(list.total, 3);
      assert.equal(list.messages[0].subject, 'Question');

      const search = await callJson(client, 'search_messages', { subject: 'report' });
      assert.equal(search.totalMatches, 1);
      const uid = search.messages[0].uid;
      assert.equal(search.messages[0].hasAttachments, true);

      const msg = await callJson(client, 'get_message', { uid });
      assert.match(msg.body.text, /See the report attached/i);
      assert.equal(msg.attachments.length, 2);
      assert.equal(msg.attachments[0].filename, 'report.txt');
      assert.equal(msg.attachments[1].filename, 'data.bin');

      const att = await call(client, 'get_attachment', { uid, part: msg.attachments[0].part });
      assert.equal(att.content[1].text, 'quarterly numbers');

      const plain = await callJson(client, 'search_messages', { from: 'alice@example.com' });
      const plainMsg = await callJson(client, 'get_message', { uid: plain.messages[0].uid });
      assert.match(plainMsg.body.text, /Grüße/);

      const unseen = await callJson(client, 'search_messages', { seen: false });
      assert.equal(unseen.totalMatches, 3, 'reading must not set \\Seen');
    });

    test('lists accounts as not writable', async () => {
      const info = await callJson(client, 'list_accounts', {});
      assert.equal(info.mode, 'read-only');
      assert.equal(info.accounts[0].writable, false);
    });
  });

  describe('read-write mode', () => {
    let client;
    before(async () => (client = await startClient(['--read-write'])));
    after(async () => client?.close());

    test('exposes write tools', async () => {
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const t of WRITE_TOOLS) assert.ok(names.includes(t), `${t} must be exposed`);
    });

    test('manages mailboxes, flags, moves and deletes', async () => {
      for (const path of ['Archive', 'Trash', 'Drafts', 'Sent', 'Temp']) {
        await call(client, 'create_mailbox', { path });
      }
      await call(client, 'rename_mailbox', { path: 'Temp', new_path: 'Temp2' });
      await call(client, 'delete_mailbox', { path: 'Temp2' });
      const boxes = (await callJson(client, 'list_mailboxes', {})).map((b) => b.path);
      assert.ok(boxes.includes('Archive') && !boxes.includes('Temp2'));

      const { messages } = await callJson(client, 'search_messages', { from: 'alice@example.com' });
      const uid = messages[0].uid;
      const flags = await callJson(client, 'update_flags', { uids: [uid], add: ['seen', 'flagged'] });
      assert.deepEqual(flags.updated[0].flags.sort(), ['\\Flagged', '\\Seen']);
      await call(client, 'update_flags', { uids: [uid], remove: ['flagged'] });

      await call(client, 'copy_messages', { uids: [uid], destination: 'Archive' });
      await call(client, 'move_messages', { uids: [uid], destination: 'Archive' });
      assert.equal((await callJson(client, 'list_messages', { mailbox: 'Archive' })).total, 2);

      const archived = await callJson(client, 'list_messages', { mailbox: 'Archive' });
      const del = await callJson(client, 'delete_messages', { mailbox: 'Archive', uids: [archived.messages[0].uid] });
      assert.equal(del.movedTo, 'Trash');
      assert.equal((await callJson(client, 'list_messages', { mailbox: 'Trash' })).total, 1);

      const trash = await callJson(client, 'list_messages', { mailbox: 'Trash' });
      await call(client, 'delete_messages', { mailbox: 'Trash', uids: [trash.messages[0].uid] });
      assert.equal((await callJson(client, 'list_messages', { mailbox: 'Trash' })).total, 0);
    });

    test('records every change in the "MCP Log" folder and protects it', async () => {
      const log = await callJson(client, 'list_messages', { mailbox: 'MCP Log', limit: 100 });
      const subjects = log.messages.map((m) => m.subject);
      for (const expected of [
        '[mcp-imap] Created folder Archive',
        '[mcp-imap] Renamed folder Temp -> Temp2',
        '[mcp-imap] Deleted folder Temp2 with 0 message(s)',
        '[mcp-imap] Flags +\\Seen +\\Flagged on 1 message(s) in INBOX',
        '[mcp-imap] Copied 1 message(s) INBOX -> Archive',
        '[mcp-imap] Moved 1 message(s) INBOX -> Archive',
        '[mcp-imap] Deleted 1 message(s) from Archive (moved to Trash)',
        '[mcp-imap] Permanently deleted 1 message(s) from Trash',
      ]) {
        assert.ok(subjects.includes(expected), `missing log entry "${expected}" in:\n${subjects.join('\n')}`);
      }
      const moved = log.messages.find((m) => m.subject === '[mcp-imap] Moved 1 message(s) INBOX -> Archive');
      const entry = await callJson(client, 'get_message', { mailbox: 'MCP Log', uid: moved.uid });
      assert.match(entry.body.text, /Action:  move_messages/);
      assert.match(entry.body.text, /Actor:   local stdio client/);
      assert.match(entry.body.text, /Alice <alice@example\.com> \| Plain hello/);

      for (const [name, args] of [
        ['delete_mailbox', { path: 'MCP Log' }],
        ['rename_mailbox', { path: 'MCP Log', new_path: 'Other' }],
        ['delete_messages', { mailbox: 'MCP Log', uids: [moved.uid], permanent: true }],
        ['move_messages', { mailbox: 'MCP Log', uids: [moved.uid], destination: 'Archive' }],
        ['update_flags', { mailbox: 'MCP Log', uids: [moved.uid], remove: ['seen'] }],
      ]) {
        const result = await client.callTool({ name, arguments: args });
        assert.ok(result.isError, `${name} on the log folder must fail`);
        assert.match(result.content[0].text, /audit log folder/);
      }
    });

    test('forwards a message with all attachments as draft', async () => {
      const { messages } = await callJson(client, 'search_messages', { subject: 'Report with attachment' });
      const uid = messages[0].uid;
      const fwd = await callJson(client, 'forward_messages', {
        uids: [uid],
        to: 'Larissa <larissa@example.com>',
        note: 'Hi Larissa,\nsee below.',
      });
      assert.equal(fwd.savedTo, 'Drafts');
      assert.equal(fwd.subject, 'Fwd: Report with attachment');
      assert.deepEqual(fwd.attachments, ['report.txt', 'data.bin']);

      const draft = await callJson(client, 'get_message', { mailbox: 'Drafts', uid: fwd.uid });
      assert.deepEqual(draft.to, ['Larissa <larissa@example.com>']);
      assert.match(draft.body.text, /^Hi Larissa,\nsee below\./);
      assert.match(draft.body.text, /---------- Forwarded message ----------\nFrom: Bob <bob@example\.com>/);
      assert.match(draft.body.text, /See the report attached/);
      assert.ok(draft.flags.includes('\\Draft'));
      const [txt, bin] = draft.attachments;
      assert.equal((await call(client, 'get_attachment', { mailbox: 'Drafts', uid: fwd.uid, part: txt.part })).content[1].text, 'quarterly numbers');
      const binary = await call(client, 'get_attachment', { mailbox: 'Drafts', uid: fwd.uid, part: bin.part });
      assert.ok(Buffer.from(binary.content[1].resource.blob, 'base64').equals(BINARY), 'binary attachment must be byte-exact');

      // Forward as .eml attachment, plus a single attachment of another message
      const question = (await callJson(client, 'search_messages', { subject: 'Question' })).messages[0];
      const report = await callJson(client, 'get_message', { uid });
      const eml = await callJson(client, 'forward_messages', {
        uids: [question.uid],
        mode: 'attachment',
        attach_from_messages: [{ uid, part: report.attachments[0].part }],
      });
      assert.deepEqual(eml.attachments, ['Question.eml', 'report.txt']);
      const emlDraft = await callJson(client, 'get_message', { mailbox: 'Drafts', uid: eml.uid });
      assert.equal(emlDraft.attachments[0].contentType, 'message/rfc822');

      // save_draft can reuse attachments of existing messages
      const withAttachment = await callJson(client, 'save_draft', {
        to: 'larissa@example.com',
        subject: 'Calendar',
        text: 'See attachment',
        attach_from_messages: [{ uid }],
      });
      assert.deepEqual(withAttachment.attachments, ['report.txt', 'data.bin']);

      const log = await callJson(client, 'list_messages', { mailbox: 'MCP Log', limit: 100 });
      assert.ok(
        log.messages.some((m) => m.subject === '[mcp-imap] Forward draft saved: "Fwd: Report with attachment" (1 message(s), 2 attachment(s))'),
      );
    });

    test('replies with quote, reply all, HTML and attachments', async () => {
      const question = (await callJson(client, 'search_messages', { subject: 'Question' })).messages[0];

      const draft = await callJson(client, 'reply_message', { uid: question.uid, text: 'Hallo Carol,\nja.', language: 'de' });
      assert.equal(draft.sent, false);
      assert.equal(draft.subject, 'Re: Question');
      assert.deepEqual(draft.to, ['carol-replies@example.com']);
      assert.deepEqual(draft.cc, []);
      const saved = await callJson(client, 'get_message', { mailbox: 'Drafts', uid: draft.uid });
      assert.equal(saved.inReplyTo, question.messageId);
      assert.match(saved.body.text, /^Hallo Carol,\nja\.\n\nAm .+ schrieb Carol <carol@example\.com>:\n> Can you answer this\?/);

      const all = await callJson(client, 'reply_message', { uid: question.uid, text: 'To everyone', reply_all: true });
      assert.deepEqual(all.to, ['carol-replies@example.com']);
      assert.deepEqual(all.cc, ['Dave <dave@example.com>'], 'own address must not be included');
      const allSaved = await callJson(client, 'get_message', { mailbox: 'Drafts', uid: all.uid });
      assert.match(allSaved.body.text, /On .+ UTC, Carol <carol@example\.com> wrote:/);

      const report = (await callJson(client, 'search_messages', { subject: 'Report with attachment' })).messages[0];
      const htmlReply = await callJson(client, 'reply_message', { uid: report.uid, text: 'Thanks!', include_attachments: true });
      assert.deepEqual(htmlReply.attachments, ['report.txt', 'data.bin']);
      const htmlSaved = await callJson(client, 'get_message', { mailbox: 'Drafts', uid: htmlReply.uid, format: 'both' });
      assert.match(htmlSaved.body.html, /<blockquote[^>]*>.*See the <b>report<\/b> attached/s);
      assert.match(htmlSaved.body.text, /^Thanks!\n\nOn .+ wrote:\n> See the report attached\./);

      const log = await callJson(client, 'list_messages', { mailbox: 'MCP Log', limit: 100 });
      assert.ok(log.messages.some((m) => m.subject === '[mcp-imap] Reply draft saved: "Re: Question" to carol-replies@example.com'));
    });

    test('sends a reply directly when send=true', async () => {
      const question = (await callJson(client, 'search_messages', { subject: 'Question' })).messages[0];
      const sent = await callJson(client, 'reply_message', { uid: question.uid, text: 'Sent answer', send: true });
      assert.equal(sent.sent, true);
      assert.deepEqual(sent.accepted, ['carol-replies@example.com']);
      assert.equal(sent.savedTo, 'Sent');
      const answered = await callJson(client, 'search_messages', { answered: true, subject: 'Question' });
      assert.equal(answered.totalMatches, 1);
    });

    test('saves a threaded reply draft', async () => {
      const { messages } = await callJson(client, 'search_messages', { subject: 'Question' });
      const draft = await callJson(client, 'save_draft', {
        reply_to_message: { uid: messages[0].uid },
        text: 'Draft answer',
      });
      assert.equal(draft.savedTo, 'Drafts');
      const saved = await callJson(client, 'get_message', { mailbox: 'Drafts', uid: draft.uid });
      assert.equal(saved.subject, 'Re: Question');
      assert.deepEqual(saved.to, ['carol-replies@example.com']);
      assert.equal(saved.inReplyTo, messages[0].messageId);
    });

    test('sends an email and stores it in Sent', async () => {
      const { messages } = await callJson(client, 'search_messages', { subject: 'Question' });
      const sent = await callJson(client, 'send_email', {
        to: user,
        subject: 'Sent via MCP',
        text: 'Hello me',
        reply_to_message: { uid: messages[0].uid },
      });
      assert.deepEqual(sent.accepted, [user]);
      assert.equal(sent.savedTo, 'Sent');
      await new Promise((r) => setTimeout(r, 500));
      const inbox = await callJson(client, 'search_messages', { subject: 'Sent via MCP' });
      assert.equal(inbox.totalMatches, 1);
      const answered = await callJson(client, 'search_messages', { answered: true });
      assert.equal(answered.messages[0].uid, messages[0].uid);
    });
  });

  describe('organize mode: read-write without delete and send', () => {
    let client;
    before(async () => (client = await startClient(['--read-write', '--no-delete', '--no-send'])));
    after(async () => client?.close());

    test('exposes no delete or send tools', async () => {
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const t of ['update_flags', 'move_messages', 'copy_messages', 'create_mailbox', 'rename_mailbox', 'save_draft', 'forward_messages', 'reply_message']) {
        assert.ok(names.includes(t), `${t} must be exposed`);
      }
      for (const t of ['delete_messages', 'delete_mailbox', 'send_email']) {
        assert.ok(!names.includes(t), `${t} must not be exposed`);
      }
      const info = await callJson(client, 'list_accounts', {});
      assert.equal(info.accounts[0].canDelete, false);
      assert.equal(info.accounts[0].canSend, false);
    });

    test('replies only as draft without send permission', async () => {
      const question = (await callJson(client, 'search_messages', { subject: 'Question' })).messages[0];
      const result = await client.callTool({ name: 'reply_message', arguments: { uid: question.uid, text: 'x', send: true } });
      assert.ok(result.isError);
      assert.match(result.content[0].text, /Sending is not permitted/);
      const draft = await callJson(client, 'reply_message', { uid: question.uid, text: 'Draft only' });
      assert.equal(draft.sent, false);
    });

    test('moves as verified copy, but never to Trash', async () => {
      const { messages } = await callJson(client, 'search_messages', { subject: 'Report with attachment' });
      const uid = messages[0].uid;
      const moved = await callJson(client, 'move_messages', { uids: [uid], destination: 'Archive' });
      assert.deepEqual(moved.moved, [uid]);
      assert.equal(moved.unverified, undefined);
      assert.equal((await callJson(client, 'search_messages', { subject: 'Report with attachment' })).totalMatches, 0);
      const archived = await callJson(client, 'search_messages', { mailbox: 'Archive', subject: 'Report with attachment' });
      assert.equal(archived.totalMatches, 1);
      assert.equal(archived.messages[0].uid, Number(moved.uidMap[uid]));

      const toTrash = await client.callTool({
        name: 'move_messages',
        arguments: { mailbox: 'Archive', uids: [archived.messages[0].uid], destination: 'Trash' },
      });
      assert.ok(toTrash.isError);
      assert.match(toTrash.content[0].text, /counts as deleting/);
      assert.equal((await callJson(client, 'search_messages', { mailbox: 'Archive', subject: 'Report with attachment' })).totalMatches, 1);
    });
  });
});
