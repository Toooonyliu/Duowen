import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { exportRecording } from '../src/exporters.js';

const qaDirectory = process.env.EXPORT_QA_DIR || await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-export-'));
await fs.mkdir(qaDirectory, { recursive: true });
const fontPath = process.env.TRANSCRIPT_CJK_FONT || new URL('../public/fonts/NotoSansSC-Regular.ttf', import.meta.url);
const fontBytes = await fs.readFile(fontPath);
const options = { fontBytes, timeZone: 'America/New_York' };

// Read the OOXML ZIP's central directory, then inflate the actual document entry.
// This independently verifies the library output without another package dependency.
function zipText(bytes, wanted) {
  const buffer = Buffer.from(bytes);
  let end = buffer.length - 22;
  for (; end >= Math.max(0, buffer.length - 65557); end--) if (buffer.readUInt32LE(end) === 0x06054b50) break;
  assert.ok(end >= 0, 'valid ZIP end-of-central-directory');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const method = buffer.readUInt16LE(offset + 10), size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28), extraLength = buffer.readUInt16LE(offset + 30), commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name === wanted) {
      const local = buffer.readUInt32LE(offset + 42);
      assert.equal(buffer.readUInt32LE(local), 0x04034b50);
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const content = buffer.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(content) : content).toString('utf8');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error('Missing OOXML entry: ' + wanted);
}

const body = '这是需要正确保留的中文转写。English words, accents café, punctuation & <draft>, and a long line should remain selectable. ';
const recording = {
  title: '产品评审 Design review / 第一期', originalFilename: '设计会议 & review.m4a',
  uploadedAt: '2026-11-05T01:00:00-05:00', duration: 420,
  speakers: [{ id: 'a', name: '林老师', confirmed: true }, { id: 'b', name: 'Maya & Noah', confirmed: false }],
  segments: Array.from({ length: 24 }, (_, index) => ({
    id: 'turn-' + index, start: index * 15, end: index * 15 + 14, speakerId: index % 2 ? 'b' : 'a',
    text: body.repeat(3) + (index === 0 ? '\n第二行保留原始换行。' : ''),
  })),
};

test('PDF is a real multipage document with a portable embedded CJK font', async () => {
  const result = await exportRecording(recording, 'pdf', options);
  const bytes = Buffer.from(await result.blob.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.equal(result.blob.type, 'application/pdf');
  const document = await PDFDocument.load(bytes);
  assert.ok(document.getPageCount() > 1, 'long transcript paginates');
  assert.equal(document.getTitle(), recording.title);
  assert.ok(bytes.length < 8_000_000, 'static TrueType embed stays within the expected download budget');
  await fs.writeFile(path.join(qaDirectory, 'multilingual.pdf'), bytes);
});

test('standalone base64 font exports a real PDF within 20 seconds', async t => {
  const payload = JSON.parse(await fs.readFile(new URL('../public/samples/sample-recordings.json', import.meta.url), 'utf8'));
  const real = payload.recordings.find(r => r.reviewStatus === 'uncorrected-asr');
  assert.ok(real, 'real ASR fixture exists');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const started = performance.now();
  Object.defineProperty(globalThis, 'window', {
    configurable: true, writable: true,
    value: { __TRANSCRIPT_EXPORT_FONT__: fontBytes.toString('base64') },
  });
  let result, elapsed;
  try {
    // Deliberately omit options.fontBytes: exercise the standalone HTML's full
    // 10 MB font decoding path, not the direct-byte test shortcut.
    result = await exportRecording(real, 'pdf', { timeZone: 'America/New_York' });
    elapsed = performance.now() - started;
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globalThis.window;
  }
  assert.ok(elapsed < 20_000, `standalone export took ${Math.round(elapsed)} ms; budget is 20000 ms`);
  const bytes = Buffer.from(await result.blob.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.equal(result.blob.type, 'application/pdf');
  assert.match(result.filename, /\.pdf$/);
  const document = await PDFDocument.load(bytes);
  assert.equal(document.getTitle(), real.title);
  assert.ok(document.getPageCount() >= 1);
  const fonts = document.getPage(0).node.Resources().lookup(PDFName.of('Font'), PDFDict);
  const font = fonts.lookup(fonts.keys()[0], PDFDict);
  const descendant = font.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict);
  const descriptor = descendant.lookup(PDFName.of('FontDescriptor'), PDFDict);
  const embeddedFont = descriptor.lookup(PDFName.of('FontFile2'), PDFRawStream);
  assert.deepEqual(Buffer.from(decodePDFRawStream(embeddedFont).decode()), fontBytes,
    'the actual PDF embeds every byte of the decoded CJK TrueType font');
  await fs.writeFile(path.join(qaDirectory, 'standalone-base64.pdf'), bytes);
  t.diagnostic(`Standalone base64 PDF: ${elapsed.toFixed(0)} ms, ${bytes.length} bytes`);
});

test('Word output contains actual OOXML and preserves Unicode and XML metacharacters', async () => {
  const result = await exportRecording(recording, 'docx', options);
  const bytes = Buffer.from(await result.blob.arrayBuffer());
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');
  assert.match(result.filename, /\.docx$/);
  const xml = zipText(bytes, 'word/document.xml');
  assert.ok(xml.includes('这是需要正确保留的中文转写'));
  assert.ok(xml.includes('林老师'));
  assert.ok(xml.includes('&lt;draft&gt;'));
  assert.ok(xml.includes('Maya &amp; Noah'));
  assert.ok(xml.includes('05:45'));
  await fs.writeFile(path.join(qaDirectory, 'multilingual.docx'), bytes);
});

test('Markdown and plain text preserve content without introducing executable HTML', async () => {
  for (const kind of ['md', 'txt']) {
    const result = await exportRecording(recording, kind, options);
    const value = await result.blob.text();
    assert.ok(value.includes('这是需要正确保留的中文转写'));
    assert.ok(value.includes('林老师'));
    assert.ok(value.includes('Nov 5, 2026'));
    assert.ok(value.includes('05:45'));
    if (kind === 'md') { assert.ok(value.startsWith('# ')); assert.ok(value.includes('&lt;draft&gt;')); }
    await fs.writeFile(path.join(qaDirectory, 'multilingual.' + kind), value);
  }
});

test('draft, approximate timing and unidentified-speaker qualifications survive every format', async () => {
  const payload = JSON.parse(await fs.readFile(new URL('../public/samples/sample-recordings.json', import.meta.url), 'utf8'));
  const real = payload.recordings.find(r => r.reviewStatus === 'uncorrected-asr');
  assert.ok(real, 'real ASR fixture exists');
  for (const kind of ['pdf', 'docx', 'md', 'txt']) {
    const result = await exportRecording(real, kind, options);
    const bytes = Buffer.from(await result.blob.arrayBuffer());
    await fs.writeFile(path.join(qaDirectory, 'real-sample.' + kind), bytes);
    if (kind === 'md' || kind === 'txt') {
      const value = await result.blob.text();
      assert.ok(value.includes('Automatic draft'));
      assert.ok(value.includes('Approximate ASR'));
      assert.ok(value.includes('unassigned label'));
    } else if (kind === 'docx') {
      const xml = zipText(bytes, 'word/document.xml');
      assert.ok(xml.includes('Automatic draft'));
      assert.ok(xml.includes('Approximate ASR'));
      assert.ok(xml.includes('unassigned label'));
    }
  }
});

test('empty transcripts are rejected and legacy doc requests keep the correct docx extension', async () => {
  await assert.rejects(exportRecording({ title: 'Empty', segments: [] }, 'pdf', options), /Add a transcript/);
  const result = await exportRecording({ ...recording, segments: recording.segments.slice(0, 1), title: 'CON' }, 'doc', options);
  assert.equal(result.filename, '_CON.docx');
});

test('user-renamed speakers and unknown timestamps survive the exported text', async () => {
  const result = await exportRecording({
    ...recording,
    segments: [{ start: null, speakerId: 'a', text: '需要人工核对的片段。' }],
  }, 'txt', { ...options, speakerName: () => 'Tony 刘' });
  const value = await result.blob.text();
  assert.ok(value.includes('[Untimed] Tony 刘'));
  assert.ok(value.includes('需要人工核对的片段。'));
});

console.log('Export QA files:', qaDirectory);
