// Unit tests of the attachment text extraction (no mail server needed).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { detectKind, Extractor, joinPages, optionalFeatures, parsePages } from '../dist/extract/index.js';
import { makeDocx, makePdf, makeScanPage, makeXlsx } from './fixtures.mjs';

const config = {
  timeoutMs: 30_000,
  memoryMb: 256,
  ocr: 'auto',
  ocrLangs: 'deu+eng',
  ocrMaxPages: 5,
  ocrTimeoutMs: 120_000,
  renderMaxPages: 3,
};
const extractor = new Extractor(config);
let n = 0;
const key = () => `test-${n++}`;
const canOcrPdf = optionalFeatures.tesseract && optionalFeatures.canvas;

describe('detectKind', () => {
  test('recognizes a PDF sent as octet-stream by its content', () => {
    const pdf = makePdf([{ lines: ['x'] }]);
    assert.deepEqual(detectKind('application/octet-stream', 'scan', pdf), { kind: 'pdf', mimeType: 'application/pdf' });
  });

  test('falls back to MIME type and file extension', () => {
    assert.equal(detectKind('application/octet-stream', 'Rechnung.PDF').kind, 'pdf');
    assert.equal(detectKind('text/csv', 'a.csv').kind, 'text');
    assert.equal(detectKind('image/jpeg', 'a.jpg').kind, 'image');
    assert.equal(detectKind('application/zip', 'a.zip').kind, 'binary');
  });
});

describe('parsePages', () => {
  test('parses ranges and clamps to the page count', () => {
    assert.deepEqual(parsePages('1-3,5', 10), [1, 2, 3, 5]);
    assert.deepEqual(parsePages('8-', 10), [8, 9, 10]);
    assert.deepEqual(parsePages(undefined, 3), [1, 2, 3]);
    assert.deepEqual(parsePages('2-20', 4), [2, 3, 4]);
    assert.throws(() => parsePages('x', 3), /Invalid page selection/);
    assert.throws(() => parsePages('5', 3), /only 3 page/);
  });
});

describe('Extractor', () => {
  test('reads the text layer of a PDF page by page', async () => {
    const pdf = makePdf([
      { lines: ['Rechnung AR-0000-635976', 'Rechnungsadresse: unikin GmbH, Musterstraße 1'] },
      { lines: ['Seite zwei', 'Gesamtbetrag 123,45 EUR'] },
    ]);
    const doc = await extractor.document(key(), 'pdf', pdf);
    assert.equal(doc.totalPages, 2);
    assert.equal(doc.pages[0].source, 'text-layer');
    assert.match(doc.pages[0].text, /unikin GmbH, Musterstraße 1/);
    const text = joinPages(doc, [1, 2]);
    assert.match(text, /--- Page 1 of 2 ---/);
    assert.match(text, /--- Page 2 of 2 ---\nSeite zwei/);
  });

  test('marks scanned pages and reads them with OCR', { skip: !canOcrPdf && 'OCR packages not installed', timeout: 180_000 }, async () => {
    const pdf = makePdf([await makeScanPage(['Rechnungsadresse', 'unikin GmbH', 'Mettmann']), { lines: ['Diese Seite hat eine Textebene'] }]);
    const k = key();
    const doc = await extractor.document(k, 'pdf', pdf);
    assert.equal(doc.pages[0].source, 'none');
    assert.equal(doc.pages[1].source, 'text-layer');
    await extractor.ocrPdfPages(doc, pdf, [1, 2]);
    assert.equal(doc.pages[0].source, 'ocr');
    assert.match(doc.pages[0].text, /unikin/i);
    // The OCR result is cached with the document.
    assert.equal((await extractor.document(k, 'pdf', pdf)).pages[0].source, 'ocr');
  });

  test('warns instead of failing when OCR is switched off', async () => {
    const off = new Extractor({ ...config, ocr: 'off' });
    const pdf = makePdf([{ lines: [' '] }]);
    const doc = await off.document(key(), 'pdf', pdf);
    await off.ocrPdfPages(doc, pdf);
    assert.equal(doc.pages[0].source, 'none');
    assert.match(doc.warnings[0], /MCP_IMAP_OCR=off/);
  });

  test('renders PDF pages as PNG', { skip: !optionalFeatures.canvas && '@napi-rs/canvas not installed' }, async () => {
    const [png] = await extractor.render(makePdf([{ lines: ['Hallo Welt, gerendert mit Standardschrift'] }]), [1]);
    assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
    // Non-embedded standard fonts must be drawn even on servers without system fonts (pdfjs-dist font data).
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const image = await loadImage(png);
    const ctx = createCanvas(image.width, image.height).getContext('2d');
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, image.width, 200).data;
    let dark = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 128) dark++;
    assert.ok(dark > 100, `rendered page has no visible text (${dark} dark pixels)`);
  });

  test('reads Word documents', async () => {
    const doc = await extractor.document(key(), 'docx', await makeDocx(['Angebot 260916', 'Klimaanlage für Büro']));
    assert.match(doc.text, /Angebot 260916\s+Klimaanlage für Büro/);
  });

  test('reads Excel workbooks sheet by sheet', async () => {
    const xlsx = await makeXlsx({ Positionen: [['Artikel', 'Preis'], ['Übernachtung', 189.5]], Summe: [['Total', 189.5]] });
    const doc = await extractor.document(key(), 'xlsx', xlsx);
    assert.match(doc.text, /## Sheet: Positionen\nArtikel\tPreis\nÜbernachtung\t189.5/);
    assert.match(doc.text, /## Sheet: Summe/);
  });

  test('reads attached e-mails and HTML', async () => {
    const eml = Buffer.from(
      'From: Hotel <rezeption@example.com>\r\nTo: ck@example.com\r\nSubject: Ihre Rechnung\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n\r\nIm Anhang die Rechnung.\r\n',
    );
    const doc = await extractor.document(key(), 'eml', eml);
    assert.match(doc.text, /^From: "?Hotel"? <rezeption@example.com>/);
    assert.match(doc.text, /Subject: Ihre Rechnung\n\nIm Anhang die Rechnung\./);
    const html = await extractor.document(key(), 'html', Buffer.from('<h1>Titel</h1><p>Absatz <b>fett</b></p>'));
    assert.match(html.text, /TITEL\n\nAbsatz fett/);
  });

  test('stops extractions that take too long and reports broken files', async () => {
    const slow = new Extractor({ ...config, timeoutMs: 1 });
    await assert.rejects(slow.document(key(), 'pdf', makePdf([{ lines: ['x'] }])), /took longer than/);
    await assert.rejects(extractor.document(key(), 'pdf', Buffer.from('%PDF-1.4 broken')), /Could not read the file/);
  });
});
