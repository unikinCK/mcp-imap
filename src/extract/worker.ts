// Runs in a worker thread: parses untrusted documents with a heap limit and a hard timeout
// (the parent terminates the thread), so a malicious file cannot stall or crash the server.
import { fileURLToPath } from 'node:url';
import { parentPort } from 'node:worker_threads';
import { htmlToPlain } from '../messages.js';

export type WorkerRequest =
  | { op: 'pdf-text'; data: Uint8Array }
  | { op: 'docx' | 'xlsx' | 'eml' | 'html'; data: Uint8Array }
  | { op: 'render'; data: Uint8Array; pages: number[]; scale: number }
  | { op: 'ocr-pdf'; data: Uint8Array; pages: number[]; ocr: OcrOptions }
  | { op: 'ocr-image'; data: Uint8Array; ocr: OcrOptions };

export interface OcrOptions {
  langs: string;
  langPath?: string;
  cachePath: string;
}

export type WorkerResponse =
  | { ok: true; totalPages?: number; pages?: string[]; text?: string; texts?: string[]; images?: Uint8Array[]; warnings?: string[] }
  | { ok: false; error: string; unavailable?: boolean };

/** Imports an optional package; the specifier is a variable so the build does not depend on it. */
async function optional<T>(name: string): Promise<T> {
  try {
    return (await import(name)) as T;
  } catch (err) {
    const e = new Error(`Optional package "${name}" is not available: ${(err as Error).message}`);
    (e as Error & { unavailable?: boolean }).unavailable = true;
    throw e;
  }
}

/**
 * pdf.js options: the standard fonts and CMaps of the optional pdfjs-dist package as file paths
 * (pdf.js reads them with fs, which does not accept the file:// URLs unpdf would pass). Without
 * them, PDFs with non-embedded standard fonts render blank on servers without system fonts.
 */
function pdfOptions() {
  try {
    const base = fileURLToPath(new URL('./', import.meta.resolve('pdfjs-dist/package.json')));
    return { standardFontDataUrl: `${base}standard_fonts/`, cMapUrl: `${base}cmaps/`, cMapPacked: true, useSystemFonts: false };
  } catch {
    return {};
  }
}

async function openPdf(data: Uint8Array) {
  const { getDocumentProxy } = await import('unpdf');
  return getDocumentProxy(data, pdfOptions());
}

async function pdfText(data: Uint8Array): Promise<WorkerResponse> {
  const { extractText } = await import('unpdf');
  const pdf = await openPdf(data);
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  return { ok: true, totalPages, pages: text };
}

async function renderPages(data: Uint8Array, pages: number[], scale: number): Promise<Uint8Array[]> {
  const { renderPageAsImage } = await import('unpdf');
  const canvas = await optional<object>('@napi-rs/canvas');
  const pdf = await openPdf(data);
  const images: Uint8Array[] = [];
  for (const page of pages) {
    const png = await renderPageAsImage(pdf, page, {
      canvasImport: async () => canvas as never,
      scale,
    });
    images.push(new Uint8Array(png));
  }
  return images;
}

interface TesseractWorker {
  recognize(image: Buffer | Uint8Array): Promise<{ data: { text: string } }>;
  terminate(): Promise<unknown>;
}

async function ocr(images: Uint8Array[], options: OcrOptions): Promise<string[]> {
  const tesseract = await optional<{
    createWorker(langs: string, oem: number, options: Record<string, unknown>): Promise<TesseractWorker>;
  }>('tesseract.js');
  const worker = await tesseract.createWorker(options.langs, 1, {
    ...(options.langPath ? { langPath: options.langPath } : {}),
    cachePath: options.cachePath,
    gzip: true,
    logger: () => undefined,
    errorHandler: () => undefined,
  });
  try {
    const texts: string[] = [];
    for (const image of images) texts.push((await worker.recognize(Buffer.from(image))).data.text);
    return texts;
  } finally {
    await worker.terminate();
  }
}

async function docx(data: Uint8Array): Promise<WorkerResponse> {
  const mammoth = (await import('mammoth')).default;
  const result = await mammoth.extractRawText({ buffer: Buffer.from(data) });
  const warnings = result.messages.filter((m) => m.type === 'error').map((m) => m.message);
  return { ok: true, text: result.value, warnings: warnings.length ? warnings : undefined };
}

function cellText(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ').trim();
}

async function xlsx(data: Uint8Array): Promise<WorkerResponse> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(data) as never);
  const parts: string[] = [];
  workbook.eachSheet((sheet) => {
    const rows: string[] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        cells[col - 1] = cellText(cell.text ?? '');
      });
      rows.push(Array.from(cells, (c) => c ?? '').join('\t'));
    });
    parts.push(`## Sheet: ${sheet.name}\n${rows.join('\n')}`);
  });
  return { ok: true, text: parts.join('\n\n') };
}

type AddressValue = { text: string } | { text: string }[] | undefined;

function addresses(value: AddressValue): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value.map((v) => v.text).join(', ') : value.text;
}

async function eml(data: Uint8Array): Promise<WorkerResponse> {
  const { simpleParser } = await import('mailparser');
  const mail = await simpleParser(Buffer.from(data), { skipImageLinks: true });
  const lines: string[] = [];
  const header = (name: string, value?: string) => value && lines.push(`${name}: ${value}`);
  header('From', addresses(mail.from));
  header('To', addresses(mail.to as AddressValue));
  header('Cc', addresses(mail.cc as AddressValue));
  header('Date', mail.date?.toISOString());
  header('Subject', mail.subject);
  lines.push('');
  lines.push(mail.text?.trim() || (typeof mail.html === 'string' ? htmlToPlain(mail.html) : ''));
  if (mail.attachments.length) {
    lines.push('', `Attachments (${mail.attachments.length}):`);
    for (const a of mail.attachments) lines.push(`- ${a.filename ?? '(no name)'} (${a.contentType}, ${a.size} bytes)`);
  }
  return { ok: true, text: lines.join('\n') };
}

async function handle(req: WorkerRequest): Promise<WorkerResponse> {
  switch (req.op) {
    case 'pdf-text':
      return pdfText(req.data);
    case 'docx':
      return docx(req.data);
    case 'xlsx':
      return xlsx(req.data);
    case 'eml':
      return eml(req.data);
    case 'html':
      return { ok: true, text: htmlToPlain(Buffer.from(req.data).toString('utf8')) };
    case 'render':
      return { ok: true, images: await renderPages(req.data, req.pages, req.scale) };
    case 'ocr-pdf': {
      const images = await renderPages(req.data, req.pages, 2.5);
      return { ok: true, texts: await ocr(images, req.ocr) };
    }
    case 'ocr-image':
      return { ok: true, texts: await ocr([req.data], req.ocr) };
  }
}

parentPort?.once('message', async (req: WorkerRequest) => {
  let res: WorkerResponse;
  try {
    res = await handle(req);
  } catch (err) {
    const e = err as Error & { unavailable?: boolean };
    res = { ok: false, error: e?.message ?? String(err), unavailable: e?.unavailable };
  }
  parentPort!.postMessage(res);
});
