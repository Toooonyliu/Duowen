import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = path.join(root, 'dist/client');
const mime = { '.js': 'text/javascript', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.png': 'image/png' };
function localFile(url, base = client) {
  const clean = decodeURIComponent(url.split(/[?#]/)[0]);
  const filename = path.resolve(clean.startsWith('/') ? client : base, clean.replace(/^\//, ''));
  if (!filename.startsWith(client + path.sep)) throw new Error(`Asset outside build: ${url}`);
  return filename;
}
function dataUrl(filename) {
  return `data:${mime[path.extname(filename)] || 'application/octet-stream'};base64,${fs.readFileSync(filename).toString('base64')}`;
}
function inlineCss(filename) {
  return fs.readFileSync(filename, 'utf8').replace(/url\((['"]?)([^'"\)]+)\1\)/g, (match, quote, url) => {
    if (/^(data:|https?:|#)/.test(url)) return match;
    return `url("${dataUrl(localFile(url, path.dirname(filename)))}")`;
  });
}

let html = fs.readFileSync(path.join(client, 'index.html'), 'utf8');
const data = JSON.parse(fs.readFileSync(path.join(client, 'samples/sample-recordings.json'), 'utf8'));
for (const recording of data.recordings) recording.audioUrl = dataUrl(localFile(recording.audioUrl));
const seed = JSON.stringify(data).replaceAll('<', '\\u003c');
const pdfFont = dataUrl(path.join(client, 'fonts/NotoSansSC-Regular.ttf'));
const workerAssets = fs.readdirSync(path.join(client, 'assets')).filter(name => /^export-worker-.*\.js$/.test(name));
if (workerAssets.length !== 1) throw new Error('Expected one PDF worker build asset.');
const pdfWorker = dataUrl(path.join(client, 'assets', workerAssets[0]));
html = html.replace('</head>', `<script>window.__DEMO_RECORDINGS__=${seed};window.__TRANSCRIPT_EXPORT_FONT__=${JSON.stringify(pdfFont)};window.__TRANSCRIPT_EXPORT_WORKER__=${JSON.stringify(pdfWorker)};</script></head>`);
html = html.replace(/<link\b[^>]*rel="stylesheet"[^>]*>/g, tag => {
  const href = tag.match(/href="([^"]+)"/);
  if (!href) return tag;
  return `<style>${inlineCss(localFile(href[1]))}</style>`;
});
html = html.replace(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g, (tag, src) => {
  // Font/PDF dependencies contain literal controls in strings and regexes.
  // Equivalent JS escapes keep them valid when parsed inside an HTML script.
  const script = fs.readFileSync(localFile(src), 'utf8')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .replace(/<\/script/gi, '<\\/script');
  return `<script type="module">${script}</script>`;
});
html = html.replace(/<link\b[^>]*rel="modulepreload"[^>]*>/g, '');
const iconLicense = path.join(root, 'licenses/Phosphor-MIT.txt');
if (fs.existsSync(iconLicense)) html = html.replace(/<!doctype html>/i, `<!doctype html>\n<!-- Phosphor Icons license\n${fs.readFileSync(iconLicense, 'utf8')}\n-->`);
const fontLicense = path.join(root, 'licenses/Noto-OFL.txt');
if (fs.existsSync(fontLicense)) html = html.replace(/<!doctype html>/i, `<!doctype html>\n<!-- Noto font license\n${fs.readFileSync(fontLicense, 'utf8')}\n-->`);
const out = path.join(root, 'Transcript-Demo.html');
fs.writeFileSync(out, html);
console.log(`Standalone HTML: ${out} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB)`);
