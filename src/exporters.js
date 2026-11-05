import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {
  AlignmentType, Document, Footer, HeadingLevel, Packer, PageNumber, Paragraph, TextRun,
} from 'docx';

const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  md: 'text/markdown;charset=utf-8',
  txt: 'text/plain;charset=utf-8',
};
let fontRequest;

// XML 1.0 and PDF text exclude these controls; preserve all normal Unicode and newlines.
function text(value = '') {
  return String(value ?? '').normalize('NFC').replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
}
function oneLine(value) { return text(value).replace(/\s+/gu, ' ').trim(); }
function filename(title, extension) {
  const safe = oneLine(title).replace(/[<>:"/\\|?*\u007F]/g, '_').replace(/[. ]+$/g, '').slice(0, 140);
  const portable = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe) ? '_' + safe : safe;
  return (portable || 'transcript') + '.' + extension;
}
function timestamp(value) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return 'Untimed';
  const seconds = Math.max(0, Math.floor(Number(value)));
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60;
  return (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
function uploadedAt(value, timeZone) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return oneLine(value);
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}),
  }).format(date);
}
function recordingData(recording, options) {
  if (!recording || !Array.isArray(recording.segments) || !recording.segments.some(s => text(s.text).trim())) {
    throw new Error('Add a transcript before exporting.');
  }
  const speakers = new Map((recording.speakers || []).map(s => [s.id, oneLine(s.name || s.label || 'Unknown speaker')]));
  const turns = recording.segments.map(segment => {
    let speaker = typeof options.speakerName === 'function' ? options.speakerName(segment.speakerId) : speakers.get(segment.speakerId);
    speaker = oneLine(speaker || 'Unknown speaker');
    return { time: timestamp(segment.start), speaker, body: text(segment.text) };
  });
  const metadata = [];
  if (recording.originalFilename || recording.filename) metadata.push(['Original file', oneLine(recording.originalFilename || recording.filename)]);
  if (recording.uploadedAt) metadata.push(['Uploaded', uploadedAt(recording.uploadedAt, options.timeZone)]);
  if (recording.duration !== null && recording.duration !== undefined && Number.isFinite(Number(recording.duration))) metadata.push(['Duration', timestamp(recording.duration)]);
  if (recording.reviewStatus === 'uncorrected-asr') metadata.push(['Transcript', 'Automatic draft - not manually corrected']);
  if (recording.timingSource === 'asr-segment-approximate') metadata.push(['Timing', 'Approximate ASR segment timestamps']);
  if (recording.diarizationStatus === 'not-run') metadata.push(['Speakers', 'Not identified; Unknown speaker is an unassigned label']);
  else if ((recording.speakers || []).some(s => s.confirmed === false)) metadata.push(['Speakers', 'Some speaker identities are unconfirmed']);
  if (recording.provenance?.clipEndSeconds !== undefined) metadata.push(['Excerpt', `${timestamp(recording.provenance.clipStartSeconds || 0)} - ${timestamp(recording.provenance.clipEndSeconds)} of the original recording`]);
  return { title: oneLine(recording.title || recording.originalFilename || 'Transcript'), metadata, turns };
}
function plainText(data) {
  return [data.title, ...data.metadata.map(([label, value]) => `${label}: ${value}`), '',
    ...data.turns.flatMap(turn => [`[${turn.time}] ${turn.speaker}`, turn.body, ''])].join('\n');
}
function markdownText(value) {
  return text(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+!|~])/g, '\\$1');
}
function markdown(data) {
  return [`# ${markdownText(data.title)}`, '',
    ...data.metadata.map(([label, value]) => `- **${label}:** ${markdownText(value)}`), '',
    ...data.turns.flatMap(turn => [
      `## ${turn.time} · ${markdownText(turn.speaker)}`, '',
      markdownText(turn.body).split('\n').join('  \n'), '',
    ])].join('\n');
}
function decodeFont(value) {
  const encoded = String(value).split(',').pop();
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
async function fontBytes(options) {
  if (options.fontBytes) return options.fontBytes;
  if (typeof window !== 'undefined' && window.__TRANSCRIPT_EXPORT_FONT__) return decodeFont(window.__TRANSCRIPT_EXPORT_FONT__);
  if (!fontRequest) {
    fontRequest = fetch(new URL('./fonts/NotoSansSC-Regular.ttf', document.baseURI)).then(async response => {
      if (!response.ok) throw new Error('The PDF font could not be loaded. Check your connection and try again.');
      return response.arrayBuffer();
    }).catch(error => { fontRequest = undefined; throw error; });
  }
  return fontRequest;
}

function wrapPdf(value, font, size, width) {
  const lines = [];
  for (const paragraph of text(value).split('\n')) {
    if (!paragraph) { lines.push(''); continue; }
    let line = '';
    for (const character of Array.from(paragraph)) {
      const candidate = line + character;
      if (line && font.widthOfTextAtSize(candidate, size) > width) {
        // Prefer a word boundary for Latin text; CJK and long tokens still wrap safely.
        const breakAt = line.lastIndexOf(' ');
        if (breakAt > line.length * .35) {
          lines.push(line.slice(0, breakAt).trimEnd());
          line = line.slice(breakAt + 1) + character;
        } else {
          lines.push(line.trimEnd());
          line = character.trimStart();
        }
      } else line = candidate;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
async function pdf(data, options) {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  document.setTitle(data.title);
  document.setSubject('Timestamped transcript');
  document.setCreator('Transcript Workspace');
  document.setProducer('Transcript Workspace / pdf-lib');
  // fontkit's runtime CJK subsets can drop visible glyphs even when extraction succeeds.
  // Embed this static TrueType font intact so exported Chinese remains readable offline.
  const font = await document.embedFont(await fontBytes(options), {
    subset: false,
    // The SC font already has the intended CJK forms. Avoid substituting unmapped
    // localized glyph IDs, whose default PDF width would add gaps to timestamps.
    features: { locl: false },
  });
  const width = 595.28, height = 841.89, margin = 48, measure = width - margin * 2;
  const ink = rgb(24 / 255, 59 / 255, 64 / 255), muted = rgb(86 / 255, 106 / 255, 111 / 255);
  const pages = [];
  let page, y;
  const nextPage = () => {
    page = document.addPage([width, height]); pages.push(page); y = height - margin;
    page.setFont(font);
    if (pages.length > 1) {
      const runningTitle = wrapPdf(data.title, font, 9, measure)[0];
      page.drawText(runningTitle, { x: margin, y, size: 9, color: muted });
      y -= 28;
    }
  };
  const ensure = needed => { if (y - needed < margin + 18) nextPage(); };
  const draw = (value, size, lineHeight, color = ink) => {
    for (const line of wrapPdf(value, font, size, measure)) {
      ensure(lineHeight);
      if (line) page.drawText(line, { x: margin, y, size, color });
      y -= lineHeight;
    }
  };
  nextPage();
  draw(data.title, 20, 28);
  y -= 8;
  data.metadata.forEach(([label, value]) => draw(`${label}: ${value}`, 9.5, 15, muted));
  y -= 18;
  for (const turn of data.turns) {
    ensure(42);
    draw(`${turn.time}  ${turn.speaker}`, 11, 17);
    draw(turn.body, 11, 17.5);
    y -= 12;
  }
  pages.forEach((p, index) => p.drawText(`${index + 1} / ${pages.length}`, {
    x: width - margin - 45, y: 28, size: 9, color: muted,
  }));
  const bytes = await document.save();
  return new Blob([bytes], { type: MIME.pdf });
}
function textRuns(value, properties = {}) {
  return text(value).split('\n').flatMap((line, index) => [
    ...(index ? [new TextRun({ break: 1 })] : []), new TextRun({ text: line, ...properties }),
  ]);
}
async function word(data) {
  const metadata = data.metadata.map(([label, value]) => new Paragraph({
    children: [new TextRun({ text: `${label}: `, bold: true }), new TextRun(value)],
    spacing: { after: 70 },
  }));
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: data.title, bold: true, size: 38, color: '183B40' })], spacing: { after: 240 } }),
    ...metadata,
    ...data.turns.flatMap(turn => [
      new Paragraph({ children: [new TextRun({ text: `${turn.time}  ${turn.speaker}`, bold: true, color: '183B40' })], keepNext: true, spacing: { before: 240, after: 80 } }),
      new Paragraph({ children: textRuns(turn.body), spacing: { after: 120, line: 300 } }),
    ]),
  ];
  const document = new Document({
    title: data.title, subject: 'Timestamped transcript', creator: 'Transcript Workspace',
    styles: { default: { document: {
      run: { font: { ascii: 'Aptos', hAnsi: 'Aptos', eastAsia: 'Noto Sans SC' }, size: 22, color: '24383D', language: { value: 'en-US', eastAsia: 'zh-CN' } },
      paragraph: { spacing: { after: 120, line: 300 } },
    } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 850, right: 850, bottom: 850, left: 850 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '566A6F' })] })] }) },
      children,
    }],
  });
  return Packer.toBlob(document);
}

/** Generate real downloadable documents; callers own progress UI and browser download handling. */
export async function exportRecording(recording, format, options = {}) {
  const kind = String(format).toLowerCase() === 'doc' ? 'docx' : String(format).toLowerCase();
  if (!Object.hasOwn(MIME, kind)) throw new Error('Choose PDF, Word (.docx), Markdown or plain text.');
  const data = recordingData(recording, options);
  let blob;
  if (kind === 'pdf') blob = await pdf(data, options);
  else if (kind === 'docx') blob = await word(data);
  else blob = new Blob([kind === 'md' ? markdown(data) : plainText(data)], { type: MIME[kind] });
  return { blob, filename: filename(data.title, kind) };
}
