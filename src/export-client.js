import { exportRecording as exportDirectly } from './exporters.js';

let defaultFont;

function decodeBase64Font(value) {
  const encoded = String(value);
  const binary = atob(encoded.slice(encoded.indexOf(',') + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

async function fontBuffer(options) {
  if (options.fontBytes) {
    const bytes = options.fontBytes;
    // Transfer a copy; callers and the shared cache must retain their font data.
    if (ArrayBuffer.isView(bytes)) return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    if (bytes instanceof ArrayBuffer) return bytes.slice(0);
    throw new Error('The PDF font must be an ArrayBuffer or typed array.');
  }
  if (!defaultFont) {
    defaultFont = Promise.resolve().then(async () => {
      if (typeof window !== 'undefined' && window.__TRANSCRIPT_EXPORT_FONT__) {
        return decodeBase64Font(window.__TRANSCRIPT_EXPORT_FONT__);
      }
      const response = await fetch(new URL('./fonts/NotoSansSC-Regular.ttf', document.baseURI));
      if (!response.ok) throw new Error('The PDF font could not be loaded. Check your connection and try again.');
      return response.arrayBuffer();
    }).catch(error => { defaultFont = undefined; throw error; });
  }
  return (await defaultFont).slice(0);
}

function resolveSpeakers(recording, speakerName) {
  if (typeof speakerName !== 'function') return recording;
  const speakers = new Map((recording.speakers || []).map(speaker => [speaker.id, { ...speaker }]));
  for (const segment of recording.segments || []) {
    const existing = speakers.get(segment.speakerId) || { id: segment.speakerId };
    speakers.set(segment.speakerId, { ...existing, name: String(speakerName(segment.speakerId) || 'Unknown speaker') });
  }
  return { ...recording, speakers: [...speakers.values()] };
}

async function makeWorker() {
  const embedded = typeof window !== 'undefined' && window.__TRANSCRIPT_EXPORT_WORKER__;
  let ownedUrl;
  try {
    if (embedded) {
      let url = embedded;
      if (embedded instanceof Blob || String(embedded).startsWith('data:')) {
        const blob = embedded instanceof Blob ? embedded : await (await fetch(embedded)).blob();
        ownedUrl = URL.createObjectURL(new Blob([blob], { type: 'text/javascript' }));
        url = ownedUrl;
      }
      return { worker: new Worker(url, { type: 'module' }), ownedUrl };
    }
    // Keep this static expression: Vite builds a separate, self-contained worker.
    return { worker: new Worker(new URL('./export-worker.js', import.meta.url), { type: 'module' }) };
  } catch (error) {
    if (ownedUrl) URL.revokeObjectURL(ownedUrl);
    throw new Error('PDF background processing could not start. ' + (error.message || 'Try a current browser.'));
  }
}

/** Same document API, with CPU-heavy PDF generation isolated from the page. */
export async function exportRecording(recording, format, options = {}) {
  if (String(format).toLowerCase() !== 'pdf') return exportDirectly(recording, format, options);
  if (typeof Worker !== 'function') throw new Error('This browser cannot run PDF background processing. Export Word or text, or use a current browser.');
  // Freeze the clicked transcript before awaiting fonts or starting a worker.
  // Playback URLs are irrelevant to document export and can be large data URLs.
  const { audioUrl, ...documentData } = resolveSpeakers(recording, options.speakerName);
  const data = structuredClone(documentData);
  const fontBytes = await fontBuffer(options);
  const { worker, ownedUrl } = await makeWorker();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      worker.terminate();
      if (ownedUrl) URL.revokeObjectURL(ownedUrl);
    };
    const fail = error => {
      if (settled) return;
      settled = true; cleanup(); reject(error);
    };
    worker.addEventListener('message', event => {
      if (settled) return;
      if (event.data?.type === 'complete' && event.data.blob instanceof Blob) {
        settled = true; cleanup(); resolve({ blob: event.data.blob, filename: event.data.filename });
      } else fail(new Error(event.data?.message || 'PDF background processing returned an invalid response.'));
    }, { once: true });
    worker.addEventListener('error', event => {
      event.preventDefault?.();
      fail(new Error('PDF background processing failed. ' + (event.message || 'Please try again.')));
    }, { once: true });
    worker.addEventListener('messageerror', () => fail(new Error('The PDF could not be received from background processing.')), { once: true });
    timeout = setTimeout(() => fail(new Error('PDF generation took longer than 60 seconds. Please retry or export Word or text.')), 60_000);
    try {
      worker.postMessage({
        recording: data,
        options: { fontBytes, ...(options.timeZone ? { timeZone: options.timeZone } : {}) },
      }, [fontBytes]);
    } catch (error) { fail(new Error('PDF background processing could not receive this transcript. ' + error.message)); }
  });
}
