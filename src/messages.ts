import type { FetchMessageObject, ImapFlow, MessageAddressObject, MessageStructureObject } from 'imapflow';
import { convert as htmlToText } from 'html-to-text';

export interface AttachmentInfo {
  part: string;
  filename?: string;
  contentType: string;
  size?: number;
  disposition?: string;
  contentId?: string;
}

interface BodyParts {
  text?: MessageStructureObject;
  html?: MessageStructureObject;
  attachments: AttachmentInfo[];
}

export function formatAddress(a: MessageAddressObject): string {
  if (a.name && a.address) return `${a.name} <${a.address}>`;
  return a.address ?? a.name ?? '';
}

export function formatAddresses(list?: MessageAddressObject[]): string[] | undefined {
  if (!list || list.length === 0) return undefined;
  return list.map(formatAddress);
}

function toIso(value?: Date | string): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function filenameOf(node: MessageStructureObject): string | undefined {
  return node.dispositionParameters?.filename ?? node.parameters?.name;
}

/** Splits a BODYSTRUCTURE tree into the main text/html bodies and the attachments. */
export function analyzeStructure(root?: MessageStructureObject): BodyParts {
  const result: BodyParts = { attachments: [] };
  if (!root) return result;

  const visit = (node: MessageStructureObject, isRoot: boolean) => {
    const type = (node.type || 'text/plain').toLowerCase();
    if (type.startsWith('multipart/') && node.childNodes) {
      node.childNodes.forEach((child) => visit(child, false));
      return;
    }
    // For a single-part message the root node has no part number; its body is part "1".
    const part = node.part ?? (isRoot ? '1' : undefined);
    if (!part) return;
    const filename = filenameOf(node);
    const isAttachment = node.disposition === 'attachment' || Boolean(filename);
    if (!isAttachment && type === 'text/plain' && !result.text) {
      result.text = { ...node, part };
      return;
    }
    if (!isAttachment && type === 'text/html' && !result.html) {
      result.html = { ...node, part };
      return;
    }
    result.attachments.push({
      part,
      filename,
      contentType: type,
      size: node.size,
      disposition: node.disposition,
      contentId: node.id,
    });
  };

  visit(root, true);
  return result;
}

export function summarize(msg: FetchMessageObject, mailbox: string) {
  const env = msg.envelope ?? {};
  const structure = analyzeStructure(msg.bodyStructure);
  return {
    uid: msg.uid,
    mailbox,
    date: toIso(env.date) ?? toIso(msg.internalDate),
    from: formatAddresses(env.from),
    to: formatAddresses(env.to),
    cc: formatAddresses(env.cc),
    subject: env.subject ?? '',
    flags: msg.flags ? [...msg.flags] : [],
    size: msg.size,
    hasAttachments: msg.bodyStructure ? structure.attachments.length > 0 : undefined,
    messageId: env.messageId,
  };
}

export const SUMMARY_QUERY = {
  uid: true,
  envelope: true,
  flags: true,
  internalDate: true,
  size: true,
  bodyStructure: true,
} as const;

export async function fetchSummaries(client: ImapFlow, mailbox: string, uids: number[]) {
  if (uids.length === 0) return [];
  const messages = await client.fetchAll(uids.join(','), SUMMARY_QUERY, { uid: true });
  const byUid = new Map(messages.map((m) => [m.uid, m]));
  // Preserve the order of the requested UIDs (typically newest first).
  return uids.flatMap((uid) => {
    const msg = byUid.get(uid);
    return msg ? [summarize(msg, mailbox)] : [];
  });
}

async function streamToBuffer(stream: NodeJS.ReadableStream, limit?: number): Promise<{ data: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (truncated) continue; // keep draining so the IMAP connection stays in a clean state
    if (limit !== undefined && size + buf.length > limit) {
      chunks.push(buf.subarray(0, limit - size));
      size = limit;
      truncated = true;
      continue;
    }
    chunks.push(buf);
    size += buf.length;
  }
  return { data: Buffer.concat(chunks), truncated };
}

/** Downloads a single body part (decoded, text converted to UTF-8). */
export async function downloadPart(client: ImapFlow, uid: number, part: string, limit?: number) {
  const download = await client.download(String(uid), part, { uid: true });
  if (!('content' in download) || !download.content) {
    throw new Error(`Part ${part} of message ${uid} was not found.`);
  }
  const { data, truncated } = await streamToBuffer(download.content, limit);
  return { meta: download.meta, data, truncated };
}

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

export function htmlToPlain(html: string): string {
  return htmlToText(html, {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
    ],
  });
}

/** Parses a header block (as returned by FETCH BODY[HEADER]) into a key -> values map. */
export function parseHeaders(raw: Buffer | string | undefined): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!raw) return result;
  const unfolded = raw.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    (result[key] ??= []).push(line.slice(idx + 1).trim());
  }
  return result;
}
