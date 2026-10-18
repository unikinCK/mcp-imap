import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import type { ImapFlow, MessageStructureObject } from 'imapflow';
import { z } from 'zod';
import { type AttachmentLinker, type AttachmentRef, attachmentKey, RESOURCE_TEMPLATE, resourceUri, uidValidityOf } from '../attachments.js';
import type { AccountConfig, ServerConfig } from '../config.js';
import { detectKind, type DocKind, type ExtractedDocument, Extractor, IMAGE_TYPES, joinPages, parsePages } from '../extract/index.js';
import { type AccountManager, ToolError } from '../imap.js';
import { analyzeStructure, downloadPart, filenameOf, findPart } from '../messages.js';
import { accountArg, handler, mailboxArg } from './common.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const KINDS = ['pdf', 'docx', 'xlsx', 'eml', 'html', 'text', 'image', 'binary'] as const;

const partArg = z.string().regex(/^[0-9]+(\.[0-9]+)*$/, 'Part id like "2" or "1.2"');

const textInfoSchema = z.object({
  method: z.string().describe('How the text was obtained: text, pdf-text-layer, docx, xlsx, eml, html or ocr.'),
  offset: z.number(),
  returnedChars: z.number(),
  totalChars: z.number(),
  truncated: z.boolean(),
  nextOffset: z.number().optional().describe('Pass as offset to get the next chunk.'),
  totalPages: z.number().optional(),
  pages: z.array(z.number()).optional().describe('PDF pages included in this response.'),
  ocrPages: z.array(z.number()).optional().describe('Pages whose text comes from OCR.'),
  pagesWithoutText: z.array(z.number()).optional().describe('Scanned pages that could not be read.'),
});

const attachmentOutput = {
  uid: z.number(),
  mailbox: z.string(),
  part: z.string(),
  filename: z.string().optional(),
  contentType: z.string(),
  size: z.number().optional().describe('Decoded size in bytes.'),
  kind: z.enum(KINDS),
  format: z.enum(['text', 'raw', 'images', 'link']).describe('What this response contains.'),
  resourceUri: z.string().describe('MCP resource URI (resources/read) of the original file.'),
  downloadUrl: z.string().optional().describe('Short-lived HTTPS link to the original file, usable without a token.'),
  downloadExpiresAt: z.string().optional(),
  text: z.string().optional(),
  textInfo: textInfoSchema.optional(),
  images: z.number().optional().describe('Number of image content blocks (e.g. rendered PDF pages).'),
  warnings: z.array(z.string()).optional(),
};

type AttachmentOutput = {
  [K in keyof typeof attachmentOutput]?: z.infer<(typeof attachmentOutput)[K]>;
} & { uid: number; mailbox: string; part: string; contentType: string; kind: DocKind; format: 'text' | 'raw' | 'images' | 'link'; resourceUri: string };

function result(info: AttachmentOutput, extra: ContentBlock[] = []): CallToolResult {
  const { text, ...rest } = info;
  const content: ContentBlock[] = [{ type: 'text', text: JSON.stringify(rest, null, 2) }];
  if (text !== undefined) {
    const more = info.textInfo?.nextOffset !== undefined ? `\n\n[... truncated - continue with offset ${info.textInfo.nextOffset}]` : '';
    content.push({ type: 'text', text: text + more });
  }
  content.push(...extra);
  return { content, structuredContent: info as unknown as Record<string, unknown> };
}

function rawContent(info: AttachmentOutput, data: Buffer, kind: DocKind, mimeType: string): ContentBlock {
  if (kind === 'image' && IMAGE_TYPES.has(mimeType)) return { type: 'image', data: data.toString('base64'), mimeType };
  if (kind === 'text' || kind === 'html') return { type: 'resource', resource: { uri: info.resourceUri, mimeType, text: data.toString('utf8') } };
  return { type: 'resource', resource: { uri: info.resourceUri, mimeType, blob: data.toString('base64') } };
}

function linkContent(info: AttachmentOutput): ContentBlock {
  return {
    type: 'resource_link',
    uri: info.resourceUri,
    name: info.filename ?? `part-${info.part}`,
    mimeType: info.contentType,
    ...(info.size !== undefined ? { size: info.size } : {}),
  };
}

/** Cuts the text to the requested window and describes it. */
function window(text: string, offset: number, maxChars: number): { text: string; info: Omit<z.infer<typeof textInfoSchema>, 'method'> } {
  const slice = text.slice(offset, offset + maxChars);
  const end = offset + slice.length;
  const truncated = end < text.length;
  return {
    text: slice,
    info: { offset, returnedChars: slice.length, totalChars: text.length, truncated, ...(truncated ? { nextOffset: end } : {}) },
  };
}

async function fetchStructure(client: ImapFlow, uid: number, mailbox: string): Promise<MessageStructureObject | undefined> {
  const msg = await client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
  if (!msg) throw new ToolError(`Message UID ${uid} not found in "${mailbox}".`);
  return msg.bodyStructure;
}

export function registerAttachmentTools(
  server: McpServer,
  accounts: AccountManager,
  config: ServerConfig,
  linker?: AttachmentLinker,
): void {
  const extractor = new Extractor(config.extract);
  const ocrNote = extractor.ocrEnabled
    ? ' Scanned PDFs and images are read with OCR.'
    : ' OCR is not available on this server, so scanned PDFs have no text (use format "images" or the download link).';

  const describe = (acc: AccountConfig, client: ImapFlow, mailbox: string, uid: number, part: string, filename?: string) => {
    const ref: AttachmentRef = { account: acc.name, mailbox, uid, part, uidValidity: uidValidityOf(client), filename };
    const link = linker?.(ref);
    return {
      ref,
      base: {
        uid,
        mailbox,
        part,
        filename,
        resourceUri: resourceUri(acc.name, mailbox, uid, part),
        ...(link ? { downloadUrl: link.url, downloadExpiresAt: link.expiresAt } : {}),
      },
    };
  };

  server.registerTool(
    'get_attachment',
    {
      title: 'Get attachment',
      description:
        'Reads one attachment / body part of a message by its part id (see get_message). ' +
        'format "auto" (default) returns PDF, Word (.docx), Excel (.xlsx), attached e-mails, HTML and text files as plain text, ' +
        'images as image plus OCR text, and anything else as base64 resource. ' +
        '"text" forces text, "raw" returns the original file (base64), "images" renders PDF pages as PNG images, ' +
        '"link" returns only metadata and links without downloading. Long documents are returned in chunks: use offset ' +
        'and max_chars, and pages (e.g. "1-3") for PDFs.' +
        ocrNote +
        (linker ? ' Every response includes a short-lived downloadUrl for programs that need the original file.' : ''),
      inputSchema: {
        account: accountArg,
        mailbox: mailboxArg,
        uid: z.number().int().positive(),
        part: partArg,
        format: z.enum(['auto', 'text', 'raw', 'images', 'link']).default('auto'),
        pages: z.string().optional().describe('PDF page selection, e.g. "1-3,5" or "4-". Default: all pages (text) or the first pages (images).'),
        offset: z.number().int().min(0).default(0).describe('Start position in the extracted text, for reading long documents in chunks.'),
        max_chars: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Maximum number of characters of extracted text (default ${config.maxBodyChars}).`),
        ocr: z.boolean().default(true).describe('Use OCR for scanned PDF pages and images (slower). Only if available on the server.'),
      },
      outputSchema: attachmentOutput,
      annotations: READ_ONLY,
    },
    handler(async (args) =>
      accounts.withMailbox(args.account, args.mailbox, false, async (client, acc) => {
        const { uid, mailbox, part } = args;

        if (args.format === 'link') {
          const node = findPart(await fetchStructure(client, uid, mailbox), part);
          if (!node) throw new ToolError(`Part ${part} of message ${uid} was not found.`);
          const filename = filenameOf(node);
          const { kind, mimeType } = detectKind(node.type, filename);
          const { base } = describe(acc, client, mailbox, uid, part, filename);
          const info: AttachmentOutput = { ...base, contentType: mimeType, size: node.size, kind, format: 'link' };
          return result(info, [linkContent(info)]);
        }

        const limit = config.maxAttachmentBytes;
        const { meta, data, truncated } = await downloadPart(client, uid, part, limit);
        const filename = meta.filename;
        const { base, ref } = describe(acc, client, mailbox, uid, part, filename);
        if (truncated) {
          throw new ToolError(
            `Attachment is larger than the configured limit of ${limit} bytes (MCP_IMAP_MAX_ATTACHMENT_BYTES).` +
              ('downloadUrl' in base ? ` Download it from ${base.downloadUrl}` : ' Use format "link" or save_attachment.'),
          );
        }
        const { kind, mimeType } = detectKind(meta.contentType, filename, data);
        const info: AttachmentOutput = { ...base, contentType: mimeType, size: data.length, kind, format: 'text' };
        const warnings: string[] = [];
        const done = (extra: ContentBlock[] = []) => result({ ...info, ...(warnings.length ? { warnings } : {}) }, extra);

        if (args.format === 'raw') {
          info.format = 'raw';
          return done([rawContent(info, data, kind, mimeType)]);
        }

        const key = attachmentKey(acc, ref);

        if (args.format === 'images') {
          if (kind === 'image') {
            if (!IMAGE_TYPES.has(mimeType)) throw new ToolError(`Images of type ${mimeType} cannot be returned as image content.`);
            info.format = 'images';
            info.images = 1;
            return done([{ type: 'image', data: data.toString('base64'), mimeType }]);
          }
          if (kind !== 'pdf') throw new ToolError('format "images" is only available for PDFs and images.');
          const doc = await extractor.document(key, kind, data);
          const total = doc.totalPages ?? 0;
          let pages = args.pages ? parsePages(args.pages, total) : parsePages(`1-${extractor.maxRenderPages}`, total);
          if (pages.length > extractor.maxRenderPages) {
            warnings.push(`Only the first ${extractor.maxRenderPages} of the selected pages were rendered (MCP_IMAP_RENDER_MAX_PAGES).`);
            pages = pages.slice(0, extractor.maxRenderPages);
          }
          const images = await extractor.render(data, pages);
          info.format = 'images';
          info.images = images.length;
          info.textInfo = { method: 'render', offset: 0, returnedChars: 0, totalChars: 0, truncated: false, totalPages: total, pages };
          return done(images.map((img) => ({ type: 'image', data: img.toString('base64'), mimeType: 'image/png' })));
        }

        // format "auto" or "text"
        if (kind === 'binary') {
          if (args.format === 'text') {
            throw new ToolError(`Files of type ${mimeType} cannot be converted to text. Use format "raw" or "link".`);
          }
          warnings.push(`Files of type ${mimeType} cannot be converted to text; the original file is attached as base64 resource.`);
          info.format = 'raw';
          return done([rawContent(info, data, kind, mimeType), linkContent(info)]);
        }

        let doc: ExtractedDocument;
        try {
          doc = await extractor.document(key, kind, data);
        } catch (err) {
          if (args.format === 'text') throw err;
          warnings.push(`${(err as Error).message} The original file is attached as base64 resource.`);
          info.format = 'raw';
          return done([rawContent(info, data, kind, mimeType), linkContent(info)]);
        }

        const maxChars = args.max_chars ?? config.maxBodyChars;
        const extra: ContentBlock[] = [];
        let text: string;
        let pageInfo: Partial<z.infer<typeof textInfoSchema>> = {};
        if (doc.pages) {
          const total = doc.totalPages ?? doc.pages.length;
          const pages = parsePages(args.pages, total);
          if (args.ocr) await extractor.ocrPdfPages(doc, data, pages);
          text = joinPages(doc, pages);
          const ocrPages = pages.filter((p) => doc.pages![p - 1].source === 'ocr');
          const pagesWithoutText = pages.filter((p) => doc.pages![p - 1].source === 'none');
          if (pagesWithoutText.length && !args.ocr) warnings.push('Some pages have no text layer; call again with ocr: true to read them.');
          pageInfo = {
            totalPages: total,
            pages,
            ...(ocrPages.length ? { ocrPages } : {}),
            ...(pagesWithoutText.length ? { pagesWithoutText } : {}),
          };
        } else if (kind === 'image') {
          if (args.format === 'auto' && IMAGE_TYPES.has(mimeType)) {
            extra.push({ type: 'image', data: data.toString('base64'), mimeType });
            info.images = 1;
          }
          if (args.ocr) await extractor.ocrImage(doc, data);
          if (args.format === 'text' && doc.text === undefined) {
            throw new ToolError(args.ocr ? doc.warnings.join(' ') : 'Images can only be returned as text with OCR (ocr: true).');
          }
          text = doc.text ?? '';
        } else {
          text = doc.text ?? '';
        }
        warnings.unshift(...doc.warnings);
        const cut = window(text, args.offset, maxChars);
        info.text = cut.text;
        info.textInfo = { method: doc.method, ...cut.info, ...pageInfo };
        return done(extra);
      }),
    ),
  );

  if (config.downloadDir) registerSaveAttachment(server, accounts, config.downloadDir);

  server.registerResource(
    'attachment',
    new ResourceTemplate(RESOURCE_TEMPLATE, { list: undefined }),
    {
      title: 'Message attachment',
      description: 'Original file of a message attachment / body part. The URIs are returned by get_message and get_attachment.',
    },
    async (uri, vars) => {
      const value = (name: string) => decodeURIComponent(String(vars[name]));
      const mailbox = value('mailbox');
      const uid = Number(value('uid'));
      const part = value('part');
      if (!Number.isInteger(uid) || uid <= 0 || !/^[0-9]+(\.[0-9]+)*$/.test(part)) throw new ToolError(`Invalid attachment URI ${uri.href}`);
      return accounts.withMailbox(value('account'), mailbox, false, async (client) => {
        const { meta, data, truncated } = await downloadPart(client, uid, part, config.maxAttachmentBytes);
        if (truncated) throw new ToolError(`Attachment is larger than the configured limit of ${config.maxAttachmentBytes} bytes.`);
        const { kind, mimeType } = detectKind(meta.contentType, meta.filename, data);
        const content =
          kind === 'text' || kind === 'html' ? { text: data.toString('utf8') } : { blob: data.toString('base64') };
        return { contents: [{ uri: uri.href, mimeType, ...content }] };
      });
    },
  );
}

/** Makes a file name safe for the local file system. */
export function safeFilename(name: string | undefined, fallback: string): string {
  const cleaned = basename((name ?? '').replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 200);
  return cleaned || fallback;
}

function uniquePath(dir: string, name: string): string {
  let candidate = join(dir, name);
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; existsSync(candidate); i++) candidate = join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

function registerSaveAttachment(server: McpServer, accounts: AccountManager, downloadDir: string): void {
  const dir = resolve(downloadDir);
  server.registerTool(
    'save_attachment',
    {
      title: 'Save attachment',
      description:
        `Saves attachments of a message as files into the local download directory (${dir}), for programs and scripts ` +
        'that need the original files. Without parts, all attachments of the message are saved. Existing files are kept; ' +
        'new files get a numbered name unless overwrite is true. The mailbox is not changed.',
      inputSchema: {
        account: accountArg,
        mailbox: mailboxArg,
        uid: z.number().int().positive(),
        parts: z.array(partArg).min(1).max(100).optional().describe('Part ids (see get_message). Default: all attachments.'),
        filename: z.string().max(200).optional().describe('File name to use (only with a single part).'),
        overwrite: z.boolean().default(false),
      },
      outputSchema: {
        directory: z.string(),
        files: z.array(
          z.object({
            part: z.string(),
            filename: z.string(),
            path: z.string(),
            contentType: z.string(),
            size: z.number(),
            sha256: z.string(),
          }),
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler(async (args) =>
      accounts.withMailbox(args.account, args.mailbox, false, async (client) => {
        if (args.filename && args.parts?.length !== 1) throw new ToolError('filename can only be used together with exactly one part.');
        const structure = await fetchStructure(client, args.uid, args.mailbox);
        const parts = args.parts ?? analyzeStructure(structure).attachments.map((a) => a.part);
        if (!parts.length) throw new ToolError(`Message ${args.uid} has no attachments.`);
        mkdirSync(dir, { recursive: true });
        const files = [];
        for (const part of parts) {
          const download = await client.download(String(args.uid), part, { uid: true });
          if (!('content' in download) || !download.content) throw new ToolError(`Part ${part} of message ${args.uid} was not found.`);
          const name = safeFilename(args.filename ?? download.meta.filename, `message-${args.uid}-part-${part}.bin`);
          const target = args.overwrite ? join(dir, name) : uniquePath(dir, name);
          // Write to a temporary file first, so a failed download never leaves a partial file under the real name.
          const temp = join(dir, `.${randomBytes(6).toString('hex')}.partial`);
          const hash = createHash('sha256');
          let size = 0;
          const meter = new Transform({
            transform(chunk: Buffer, _enc, cb) {
              hash.update(chunk);
              size += chunk.length;
              cb(null, chunk);
            },
          });
          try {
            await pipeline(download.content, meter, createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
            if (!args.overwrite && existsSync(target)) throw new ToolError(`File ${target} appeared while saving; try again.`);
            renameSync(temp, target);
          } catch (err) {
            rmSync(temp, { force: true });
            throw err;
          }
          files.push({
            part,
            filename: basename(target),
            path: target,
            contentType: (download.meta.contentType || 'application/octet-stream').toLowerCase(),
            size,
            sha256: hash.digest('hex'),
          });
        }
        const data = { directory: dir, files };
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
      }),
    ),
  );
}
