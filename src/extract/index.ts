import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ExtractConfig } from '../config.js';
import { ToolError } from '../imap.js';
import type { DocKind } from './detect.js';
import type { OcrOptions, WorkerRequest, WorkerResponse } from './worker.js';

export { detectKind, IMAGE_TYPES, isTextDocument, type DocKind } from './detect.js';

/** A page without at least this many non-blank characters is treated as having no text layer (scanned). */
const MIN_PAGE_CHARS = 16;
const MAX_CONCURRENT_WORKERS = 2;
const CACHE_ENTRIES = 32;
const CACHE_TTL_MS = 15 * 60 * 1000;

export interface PageText {
  page: number;
  text: string;
  source: 'text-layer' | 'ocr' | 'none';
}

export interface ExtractedDocument {
  kind: DocKind;
  /** PDFs: one entry per page. */
  pages?: PageText[];
  totalPages?: number;
  /** Everything else. */
  text?: string;
  method: 'text' | 'pdf-text-layer' | 'docx' | 'xlsx' | 'eml' | 'html' | 'ocr';
  warnings: string[];
}

const require = createRequire(import.meta.url);

function resolvable(name: string): boolean {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

/** Which optional OCR/rendering packages are installed (checked once). */
export const optionalFeatures = {
  tesseract: resolvable('tesseract.js'),
  canvas: resolvable('@napi-rs/canvas'),
};

// --- worker pool -------------------------------------------------------------------------------

let running = 0;
const waiting: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_WORKERS) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

class UnavailableError extends ToolError {}

function runWorker(req: WorkerRequest, timeoutMs: number, memoryMb: number): Promise<WorkerResponse & { ok: true }> {
  return slot(
    () =>
      new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./worker.js', import.meta.url), {
          resourceLimits: { maxOldGenerationSizeMb: memoryMb },
          stdout: true,
          stderr: true,
        });
        // pdf.js and tesseract print warnings to stdout, which is the MCP transport in stdio mode.
        worker.stdout.resume();
        worker.stderr.resume();
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          void worker.terminate();
          fn();
        };
        const timer = setTimeout(
          () => finish(() => reject(new ToolError(`Text extraction took longer than ${Math.round(timeoutMs / 1000)} s and was stopped.`))),
          timeoutMs,
        );
        worker.once('message', (res: WorkerResponse) =>
          finish(() => {
            if (res.ok) resolve(res);
            else reject(res.unavailable ? new UnavailableError(res.error) : new ToolError(`Could not read the file: ${res.error}`));
          }),
        );
        worker.once('error', (err: Error) => finish(() => reject(new ToolError(`Could not read the file: ${err.message}`))));
        worker.once('exit', (code) =>
          finish(() => reject(new ToolError(`Text extraction stopped unexpectedly (exit code ${code}, probably out of memory).`))),
        );
        worker.postMessage(req);
      }),
  );
}

// --- OCR language data --------------------------------------------------------------------------

let ocrOptionsCache: OcrOptions | undefined;

/**
 * Tesseract needs all languages in one directory. The bundled @tesseract.js-data packages each have
 * their own, so they are copied into a temp directory once. Without them tesseract.js downloads the
 * data from its CDN.
 */
function ocrOptions(config: ExtractConfig): OcrOptions {
  if (ocrOptionsCache) return ocrOptionsCache;
  const cachePath = join(tmpdir(), 'mcp-imap-tessdata-cache');
  mkdirSync(cachePath, { recursive: true });
  let langPath = config.ocrLangPath;
  if (!langPath) {
    const files = config.ocrLangs.split('+').map((lang) => {
      try {
        const dir = dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
        const file = join(dir, '4.0.0_best_int', `${lang}.traineddata.gz`);
        return existsSync(file) ? { lang, file } : undefined;
      } catch {
        return undefined;
      }
    });
    if (files.every(Boolean)) {
      langPath = join(tmpdir(), 'mcp-imap-tessdata');
      mkdirSync(langPath, { recursive: true });
      for (const f of files) {
        const target = join(langPath, `${f!.lang}.traineddata.gz`);
        if (!existsSync(target)) copyFileSync(f!.file, target);
      }
    }
  }
  ocrOptionsCache = { langs: config.ocrLangs, langPath, cachePath };
  return ocrOptionsCache;
}

// --- cache -------------------------------------------------------------------------------------

const cache = new Map<string, { doc: ExtractedDocument; at: number }>();

function cached(key: string): ExtractedDocument | undefined {
  const entry = cache.get(key);
  if (!entry || Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  // Refresh the LRU position.
  cache.delete(key);
  cache.set(key, entry);
  return entry.doc;
}

function remember(key: string, doc: ExtractedDocument): void {
  cache.set(key, { doc, at: Date.now() });
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
}

// --- public API --------------------------------------------------------------------------------

export class Extractor {
  constructor(private readonly config: ExtractConfig) {}

  get ocrEnabled(): boolean {
    return this.config.ocr !== 'off' && optionalFeatures.tesseract;
  }

  get pdfOcrEnabled(): boolean {
    return this.ocrEnabled && optionalFeatures.canvas;
  }

  get renderEnabled(): boolean {
    return optionalFeatures.canvas;
  }

  get maxRenderPages(): number {
    return this.config.renderMaxPages;
  }

  private worker(req: WorkerRequest, ocr = false) {
    return runWorker(req, ocr ? this.config.ocrTimeoutMs : this.config.timeoutMs, this.config.memoryMb);
  }

  /**
   * Parses a document into text (PDFs: per page, from the text layer). Results are cached under
   * `key`, so paging through a long document or OCR'ing more pages does not parse it again.
   */
  async document(key: string, kind: DocKind, data: Buffer): Promise<ExtractedDocument> {
    let doc = cached(key);
    if (!doc) {
      doc = await this.parse(kind, data);
      remember(key, doc);
    }
    return doc;
  }

  private async parse(kind: DocKind, data: Buffer): Promise<ExtractedDocument> {
    const bytes = new Uint8Array(data);
    switch (kind) {
      case 'text':
        return { kind, method: 'text', text: data.toString('utf8'), warnings: [] };
      case 'pdf': {
        const res = await this.worker({ op: 'pdf-text', data: bytes });
        const pages = (res.pages ?? []).map((text, i) => ({
          page: i + 1,
          text: text.trim(),
          source: text.replace(/\s+/g, '').length >= MIN_PAGE_CHARS ? ('text-layer' as const) : ('none' as const),
        }));
        return { kind, method: 'pdf-text-layer', pages, totalPages: res.totalPages, warnings: [] };
      }
      case 'docx':
      case 'xlsx':
      case 'eml':
      case 'html': {
        const res = await this.worker({ op: kind, data: bytes });
        return { kind, method: kind, text: res.text ?? '', warnings: res.warnings ?? [] };
      }
      case 'image':
        return { kind, method: 'ocr', warnings: [] };
      default:
        throw new ToolError('This file type cannot be converted to text.');
    }
  }

  /** OCRs the pages among `wanted` that have no text layer (at most ocrMaxPages per call). */
  async ocrPdfPages(doc: ExtractedDocument, data: Buffer, wanted?: number[]): Promise<void> {
    const candidates = doc.pages!.filter((p) => p.source === 'none' && (!wanted || wanted.includes(p.page)));
    if (!candidates.length) return;
    if (!this.pdfOcrEnabled) {
      addWarning(doc, this.ocrUnavailableHint('PDF'));
      return;
    }
    const batch = candidates.slice(0, this.config.ocrMaxPages);
    if (candidates.length > batch.length) {
      addWarning(doc, `Only ${batch.length} of ${candidates.length} scanned pages were OCR'd in this call; request further pages with "pages".`);
    }
    try {
      const res = await this.worker({ op: 'ocr-pdf', data: new Uint8Array(data), pages: batch.map((p) => p.page), ocr: ocrOptions(this.config) }, true);
      batch.forEach((p, i) => {
        p.text = (res.texts?.[i] ?? '').trim();
        p.source = 'ocr';
      });
      doc.method = 'ocr';
    } catch (err) {
      // The text layer is still useful, so a failed OCR run is reported instead of failing the call.
      addWarning(doc, `OCR failed: ${(err as Error).message}`);
    }
  }

  /** Recognizes the text of an image document (once; the result is cached with the document). */
  async ocrImage(doc: ExtractedDocument, data: Buffer): Promise<void> {
    if (doc.text !== undefined) return;
    if (!this.ocrEnabled) {
      addWarning(doc, this.ocrUnavailableHint('image'));
      return;
    }
    try {
      const res = await this.worker({ op: 'ocr-image', data: new Uint8Array(data), ocr: ocrOptions(this.config) }, true);
      doc.text = (res.texts?.[0] ?? '').trim();
    } catch (err) {
      // The text layer is still useful, so a failed OCR run is reported instead of failing the call.
      addWarning(doc, `OCR failed: ${(err as Error).message}`);
    }
  }

  private ocrUnavailableHint(what: string): string {
    const reason = this.config.ocr === 'off' ? 'OCR is disabled on this server (MCP_IMAP_OCR=off)' : 'OCR is not installed on this server';
    return `The ${what} contains no text layer (probably scanned) and ${reason}. Use format "images" or "raw", or the download link.`;
  }

  /** Renders PDF pages as PNG images. */
  async render(data: Buffer, pages: number[]): Promise<Buffer[]> {
    if (!this.renderEnabled) throw new ToolError('Rendering PDF pages is not available on this server (@napi-rs/canvas is not installed).');
    try {
      const res = await this.worker({ op: 'render', data: new Uint8Array(data), pages, scale: 1.5 });
      return (res.images ?? []).map((img) => Buffer.from(img));
    } catch (err) {
      if (err instanceof UnavailableError) throw new ToolError(`Rendering PDF pages is not available on this server: ${err.message}`);
      throw err;
    }
  }
}

function addWarning(doc: ExtractedDocument, warning: string): void {
  if (!doc.warnings.includes(warning)) doc.warnings.push(warning);
}

/** Parses a page selection like "1-3,5" into sorted page numbers within 1..total. */
export function parsePages(spec: string | undefined, total: number): number[] {
  if (!spec?.trim()) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set<number>();
  for (const raw of spec.split(',')) {
    const part = raw.trim();
    const match = part.match(/^(\d+)(?:\s*-\s*(\d+)?)?$/);
    if (!match) throw new ToolError(`Invalid page selection "${part}". Use e.g. "1-3,5".`);
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : part.includes('-') ? total : from;
    if (from < 1 || to < from) throw new ToolError(`Invalid page range "${part}".`);
    for (let p = from; p <= Math.min(to, total); p++) pages.add(p);
  }
  if (!pages.size) throw new ToolError(`The document has only ${total} page(s).`);
  return [...pages].sort((a, b) => a - b);
}

/** Joins the selected PDF pages into one text with page markers. */
export function joinPages(doc: ExtractedDocument, pages: number[]): string {
  const total = doc.totalPages ?? doc.pages?.length ?? 0;
  return pages
    .map((n) => {
      const page = doc.pages![n - 1];
      const body = page.source === 'none' ? '[no text on this page - probably scanned]' : page.text;
      return total > 1 ? `--- Page ${n} of ${total} ---\n${body}` : body;
    })
    .join('\n\n');
}
