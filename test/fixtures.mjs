// Builds small test documents (PDF with text layer, scanned PDF, DOCX, XLSX) without external tools.
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

const escapePdf = (s) => s.replace(/([\\()])/g, '\\$1');

/**
 * Minimal PDF writer. Each page is { lines: string[], size? } (text layer, WinAnsi) or
 * { jpeg: Buffer, width, height } (a full-page image, like a scan).
 */
export function makePdf(pages) {
  const objects = [];
  const add = (body) => objects.push(body) && objects.length;
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
  const kids = [];
  for (const page of pages) {
    let resources;
    let content;
    if (page.jpeg) {
      const img = add(
        Buffer.concat([
          Buffer.from(
            `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB ` +
              `/BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
          ),
          page.jpeg,
          Buffer.from('\nendstream'),
        ]),
      );
      resources = `<< /XObject << /Im1 ${img} 0 R >> >>`;
      content = 'q 595 0 0 842 0 0 cm /Im1 Do Q';
    } else {
      resources = `<< /Font << /F1 ${font} 0 R >> >>`;
      const size = page.size ?? 14;
      content = `BT /F1 ${size} Tf 72 760 Td ${page.lines.map((l) => `(${escapePdf(l)}) Tj 0 -${Math.round(size * 1.4)} Td`).join(' ')} ET`;
    }
    const stream = Buffer.from(content, 'latin1');
    const contents = add(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from('\nendstream')]));
    kids.push(add(Buffer.from(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources ${resources} /Contents ${contents} 0 R >>`)));
  }
  objects[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  objects[pagesObj - 1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);

  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    offsets.push(offset);
    offset += obj.length;
    chunks.push(obj);
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

/**
 * A "scanned" page: a text page rendered to a JPEG and embedded as image, without text layer.
 * Rendering uses pdf.js' bundled standard fonts, so no system fonts are needed. Needs @napi-rs/canvas.
 */
export async function makeScanPage(lines) {
  const { getDocumentProxy, renderPageAsImage } = await import('unpdf');
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const base = fileURLToPath(new URL('./', import.meta.resolve('pdfjs-dist/package.json')));
  const doc = await getDocumentProxy(new Uint8Array(makePdf([{ lines, size: 28 }])), {
    standardFontDataUrl: `${base}standard_fonts/`,
    useSystemFonts: false,
  });
  const png = await renderPageAsImage(doc, 1, { canvasImport: () => import('@napi-rs/canvas'), scale: 2 });
  const image = await loadImage(Buffer.from(png));
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, image.width, image.height);
  ctx.drawImage(image, 0, 0);
  return { jpeg: await canvas.encode('jpeg', 92), width: image.width, height: image.height };
}

export async function makeDocx(paragraphs) {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('');
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

export async function makeXlsx(sheets) {
  const workbook = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const sheet = workbook.addWorksheet(name);
    for (const row of rows) sheet.addRow(row);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
