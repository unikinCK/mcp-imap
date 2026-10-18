/** What an attachment is, as far as text extraction is concerned. */
export type DocKind = 'pdf' | 'docx' | 'xlsx' | 'eml' | 'html' | 'text' | 'image' | 'binary';

/** Image types that MCP clients accept as image content. */
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const BY_MIME: Record<string, DocKind> = {
  'application/pdf': 'pdf',
  'application/x-pdf': 'pdf',
  [DOCX]: 'docx',
  [XLSX]: 'xlsx',
  'message/rfc822': 'eml',
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'application/json': 'text',
  'application/xml': 'text',
  'application/csv': 'text',
};

const BY_EXT: Record<string, DocKind> = {
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  eml: 'eml',
  html: 'html',
  htm: 'html',
  txt: 'text',
  csv: 'text',
  tsv: 'text',
  json: 'text',
  xml: 'text',
  md: 'text',
  ics: 'text',
  vcf: 'text',
  log: 'text',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
};

const IMAGE_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function extensionOf(filename?: string): string | undefined {
  const match = filename?.toLowerCase().match(/\.([a-z0-9]{1,5})$/);
  return match?.[1];
}

function sniff(data: Buffer): { kind: DocKind; mimeType: string } | undefined {
  if (data.length < 4) return undefined;
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') return { kind: 'pdf', mimeType: 'application/pdf' };
  if (data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
    // OOXML containers: entry names are stored uncompressed in the local file headers.
    if (data.includes('word/document')) return { kind: 'docx', mimeType: DOCX };
    if (data.includes('xl/workbook')) return { kind: 'xlsx', mimeType: XLSX };
    return undefined;
  }
  if (data[0] === 0x89 && data.subarray(1, 4).toString('latin1') === 'PNG') return { kind: 'image', mimeType: 'image/png' };
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { kind: 'image', mimeType: 'image/jpeg' };
  if (data.subarray(0, 4).toString('latin1') === 'GIF8') return { kind: 'image', mimeType: 'image/gif' };
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { kind: 'image', mimeType: 'image/webp' };
  }
  return undefined;
}

/**
 * Determines the kind of an attachment from its content (if given), MIME type and file name.
 * Mail clients often send PDFs as application/octet-stream, so the content wins over the label.
 */
export function detectKind(contentType: string | undefined, filename: string | undefined, data?: Buffer): { kind: DocKind; mimeType: string } {
  const declared = (contentType || 'application/octet-stream').toLowerCase().split(';')[0].trim();
  const sniffed = data ? sniff(data) : undefined;
  if (sniffed) return sniffed;
  const ext = extensionOf(filename);
  const byMime = BY_MIME[declared] ?? (declared.startsWith('text/') ? 'text' : declared.endsWith('+xml') ? 'text' : undefined);
  if (byMime) return { kind: byMime, mimeType: declared };
  if (declared.startsWith('image/')) return { kind: IMAGE_TYPES.has(declared) ? 'image' : 'binary', mimeType: declared };
  const byExt = ext ? BY_EXT[ext] : undefined;
  if (byExt === 'image') return { kind: 'image', mimeType: IMAGE_EXT[ext!] };
  if (byExt) return { kind: byExt, mimeType: declared };
  return { kind: 'binary', mimeType: declared };
}

/** True if get_attachment can turn this document into text without OCR. */
export function isTextDocument(contentType: string | undefined, filename: string | undefined): boolean {
  const { kind } = detectKind(contentType, filename);
  return kind !== 'binary' && kind !== 'image';
}
