import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, parseArgs } from '../dist/config.js';

const baseEnv = { IMAP_HOST: 'imap.example.com', IMAP_USER: 'me@example.com', IMAP_PASSWORD: 'secret' };

test('defaults to read-only mode', () => {
  const config = loadConfig([], baseEnv);
  assert.equal(config.mode, 'read-only');
  assert.equal(config.accounts.length, 1);
  assert.equal(config.accounts[0].imap.port, 993);
  assert.equal(config.accounts[0].imap.secure, true);
  assert.equal(config.accounts[0].smtp, undefined);
});

test('mode can be set via CLI flag or environment', () => {
  assert.equal(loadConfig(['--read-write'], baseEnv).mode, 'read-write');
  assert.equal(loadConfig(['--mode', 'read-only'], baseEnv).mode, 'read-only');
  assert.equal(loadConfig(['--mode=rw'], baseEnv).mode, 'read-write');
  assert.equal(loadConfig([], { ...baseEnv, MCP_IMAP_MODE: 'read-write' }).mode, 'read-write');
  // CLI wins over environment
  assert.equal(loadConfig(['--read-only'], { ...baseEnv, MCP_IMAP_MODE: 'read-write' }).mode, 'read-only');
});

test('rejects conflicting and unknown arguments', () => {
  assert.throws(() => parseArgs(['--read-only', '--read-write']), /Conflicting/);
  assert.throws(() => parseArgs(['--bogus']), /Unknown argument/);
  assert.throws(() => loadConfig(['--mode', 'everything'], baseEnv), /Invalid mode/);
});

test('requires IMAP credentials', () => {
  assert.throws(() => loadConfig([], { IMAP_HOST: 'x', IMAP_USER: 'y' }), /password/);
});

test('SMTP inherits IMAP credentials', () => {
  const config = loadConfig([], { ...baseEnv, SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_SECURE: 'false' });
  const smtp = config.accounts[0].smtp;
  assert.equal(smtp.host, 'smtp.example.com');
  assert.equal(smtp.port, 587);
  assert.equal(smtp.secure, false);
  assert.equal(smtp.user, 'me@example.com');
  assert.equal(smtp.password, 'secret');
  assert.equal(smtp.from, 'me@example.com');
  assert.equal(smtp.saveToSent, true);
});

test('--no-send disables sending', () => {
  assert.equal(loadConfig(['--read-write'], baseEnv).allowSend, true);
  assert.equal(loadConfig(['--read-write', '--no-send'], baseEnv).allowSend, false);
});

test('loads multiple accounts from a config file with passwordEnv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-imap-'));
  const file = join(dir, 'accounts.json');
  writeFileSync(
    file,
    JSON.stringify({
      accounts: [
        { name: 'work', imap: { host: 'imap.work.com', user: 'a@work.com', passwordEnv: 'WORK_PW' } },
        { name: 'private', readOnly: true, imap: { host: 'imap.home.com', port: 143, secure: false, user: 'b', password: 'pw' } },
      ],
    }),
  );
  const config = loadConfig(['--config', file, '--read-write'], { WORK_PW: 'pw1' });
  assert.equal(config.accounts.length, 2);
  assert.equal(config.accounts[0].imap.password, 'pw1');
  assert.equal(config.accounts[1].readOnly, true);
  assert.equal(config.accounts[1].imap.port, 143);
  assert.throws(() => loadConfig(['--config', file], {}), /WORK_PW is not set/);
});
