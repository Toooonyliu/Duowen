import { createBlobUploadHandler, MAX_BLOB_UPLOAD_BYTES, MAX_DIRECT_UPLOAD_BYTES, mediaType } from '../server/deepgram-upload.js';

const REQUEST_TIMEOUT_MS = 50_000;
const BLOB_REQUEST_TIMEOUT_MS = 250_000;
const MAX_ACTION_BYTES = 4096;
const LISTEN_URL = 'https://api.deepgram.com/v1/listen?' + new URLSearchParams({
  model: 'nova-3',
  language: 'multi',
  diarize_model: 'latest',
  smart_format: 'true',
  utterances: 'true',
  mip_opt_out: 'true',
});
const NO_STORE = { 'Cache-Control': 'no-store' };
const uploads = createBlobUploadHandler();

function errorResponse(status, code, error, headers) {
  return Response.json({ code, error }, { status, headers: { ...NO_STORE, ...headers } });
}

async function readRequestBody(request, maximumBytes) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();

  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function hasTimeBounds({ start, end }) {
  return Number.isFinite(start) && start >= 0 && Number.isFinite(end) && end >= start;
}

function speakerNumber(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function wordGroups(words, defaultSpeaker = null) {
  const groups = [];
  for (const word of words) {
    const text = word.punctuated_word || word.word;
    if (typeof text !== 'string' || !text.trim() || !hasTimeBounds(word)) continue;

    const speaker = speakerNumber(word.speaker) ?? defaultSpeaker;
    const last = groups.at(-1);
    if (!last || speaker !== last.speaker || word.start - last.end > 0.8 || last.words.length >= 40) {
      groups.push({ start: word.start, end: word.end, speaker, words: [text] });
    } else {
      last.end = Math.max(last.end, word.end);
      last.words.push(text);
    }
  }
  return groups.map(({ words: groupWords, ...group }) => ({
    ...group,
    text: groupWords.join(' ').replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}，。！？、]) (?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}，。！？、])/gu, ''),
  }));
}

function toTranscript(payload) {
  const channel = payload?.results?.channels?.[0];
  const alternative = channel?.alternatives?.[0];
  if (!alternative) return null;

  const utterances = payload.results.utterances ?? [];
  const turns = utterances.flatMap(utterance => {
    const speaker = speakerNumber(utterance.speaker);
    const words = utterance.words ?? [];
    const hasMultipleSpeakers = words.some(word => speakerNumber(word.speaker) !== null && word.speaker !== speaker);
    if (speaker !== null && !hasMultipleSpeakers && hasTimeBounds(utterance) && utterance.transcript?.trim()) {
      return [{ start: utterance.start, end: utterance.end, text: utterance.transcript.trim(), speaker }];
    }
    return wordGroups(words, speaker);
  });
  const groups = (turns.length ? turns : wordGroups(alternative.words ?? [])).sort((a, b) => a.start - b.start);
  if (!groups.length) return alternative.transcript?.trim() ? null : { segments: [] };

  const speakers = new Map();
  const segments = groups.map(({ start, end, text, speaker }, index) => {
    const speakerId = speaker === null ? 'unassigned' : `speaker-${speaker}`;
    if (!speakers.has(speakerId)) {
      speakers.set(speakerId, {
        id: speakerId,
        name: speaker === null ? 'Unknown speaker' : `Speaker ${speaker + 1}`,
        confirmed: false,
      });
    }
    return { id: `asr-segment-${index}`, start, end, text, speakerId };
  });
  const segmentEnd = segments.reduce((latest, segment) => Math.max(latest, segment.end), 0);
  const providerDuration = payload.metadata?.duration;
  const detectedLanguage = channel.detected_language;
  return {
    segments,
    speakers: [...speakers.values()],
    engine: 'deepgram',
    duration: Number.isFinite(providerDuration) ? Math.max(providerDuration, segmentEnd) : segmentEnd,
    ...(typeof detectedLanguage === 'string' && detectedLanguage !== 'multi' ? { language: detectedLanguage } : {}),
    timingSource: 'asr-word-timestamps',
    diarizationStatus: segments.some(segment => segment.speakerId !== 'unassigned') ? 'completed' : 'not-run',
  };
}

function providerError(status) {
  if (status === 429) return errorResponse(429, 'PROVIDER_BUSY', 'The transcription service is busy. Please try again shortly.');
  if (status === 402) return errorResponse(503, 'PROVIDER_CREDITS_EXHAUSTED', 'The transcription service is out of credits.');
  if (status === 401 || status === 403) return errorResponse(503, 'PROVIDER_UNAVAILABLE', 'The transcription service is unavailable.');
  if (status === 413) return errorResponse(413, 'FILE_TOO_LARGE', 'The transcription service could not accept a file of this size.');
  if (status === 400 || status === 415 || status === 422) {
    return errorResponse(422, 'INVALID_MEDIA', 'The recording could not be read. Try MP3, M4A, WAV or an MP4 with audio.');
  }
  return errorResponse(502, 'PROVIDER_ERROR', 'The transcription service could not process this recording.');
}

async function transcribeRecording(recording, contentType, signal, apiKey, size) {
  const deadline = AbortSignal.timeout(size ? BLOB_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
  try {
    const headers = { Authorization: `Token ${apiKey}`, 'Content-Type': contentType, Accept: 'application/json' };
    if (size) headers['Content-Length'] = String(size);
    const response = await fetch(LISTEN_URL, {
      method: 'POST',
      headers,
      body: recording,
      ...(size ? { duplex: 'half' } : {}),
      redirect: 'error',
      signal: AbortSignal.any([signal, deadline]),
    });
    if (!response.ok) return providerError(response.status);

    const transcript = toTranscript(await response.json());
    if (!transcript) return errorResponse(502, 'INVALID_RESULT', 'The transcription service returned an unreadable transcript.');
    if (!transcript.segments.length) return errorResponse(422, 'NO_SPEECH', 'No speech was detected. Try a recording with clear speech.');
    return Response.json(transcript, { headers: NO_STORE });
  } catch {
    if (deadline.aborted) return errorResponse(504, 'PROVIDER_TIMEOUT', 'Transcription took too long. Try a shorter recording.');
    return errorResponse(502, 'PROVIDER_ERROR', 'The transcription service could not complete this request.');
  }
}

export default {
  async fetch(request) {
    const apiKey = process.env.DEEPGRAM_API_KEY?.trim();
    const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
    const cronSecret = process.env.CRON_SECRET?.trim();
    const blobConfigured = Boolean(token && cronSecret);
    const url = new URL(request.url);
    if (request.method === 'GET') {
      if (url.searchParams.get('cleanup') === '1') return uploads.cleanup(request, { token, cronSecret });
      const maxUploadBytes = apiKey && blobConfigured ? MAX_BLOB_UPLOAD_BYTES : MAX_DIRECT_UPLOAD_BYTES;
      return Response.json({ configured: Boolean(apiKey), maxUploadBytes }, { status: apiKey ? 200 : 503, headers: NO_STORE });
    }
    if (request.method !== 'POST') return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Use POST to upload a recording.', { Allow: 'GET, POST' });

    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) {
      return errorResponse(403, 'ORIGIN_NOT_ALLOWED', 'Upload recordings directly from Duowen.');
    }

    const contentTypeHeader = request.headers.get('content-type') ?? '';
    if (contentTypeHeader.split(';')[0].trim().toLowerCase() === 'application/json') {
      if (!blobConfigured) return errorResponse(503, 'BLOB_NOT_CONFIGURED', 'Large file uploads are unavailable. Choose a recording under 4 MB.');
      let action;
      try {
        const body = await readRequestBody(request, MAX_ACTION_BYTES);
        if (!body) return errorResponse(413, 'UPLOAD_ACTION_TOO_LARGE', 'The upload action is too large.');
        action = JSON.parse(body.toString('utf8'));
      } catch {
        return errorResponse(400, 'INVALID_ACTION', 'The upload action could not be read.');
      }
      if (!apiKey && action?.action !== 'cancel') {
        return errorResponse(503, 'BACKEND_NOT_CONFIGURED', 'The transcription service is not connected yet.');
      }
      return uploads.handle(action, request, {
        token,
        transcribe: (recording, contentType, signal, size) => transcribeRecording(recording, contentType, signal, apiKey, size),
      });
    }

    if (!apiKey) return errorResponse(503, 'BACKEND_NOT_CONFIGURED', 'The transcription service is not connected yet.');
    const contentType = mediaType(contentTypeHeader);
    if (!contentType) return errorResponse(415, 'UNSUPPORTED_MEDIA', 'Upload an audio or video file.');
    const tooLarge = () => errorResponse(413, 'FILE_TOO_LARGE', 'Direct uploads accept files up to 4 MB.');
    if (Number(request.headers.get('content-length')) > MAX_DIRECT_UPLOAD_BYTES) return tooLarge();
    let recording;
    try {
      recording = await readRequestBody(request, MAX_DIRECT_UPLOAD_BYTES);
    } catch {
      return errorResponse(400, 'UPLOAD_FAILED', 'The upload was interrupted. Please try again.');
    }
    if (!recording) return tooLarge();
    if (!recording.byteLength) return errorResponse(400, 'EMPTY_FILE', 'Choose a recording that contains audio.');

    return transcribeRecording(recording, contentType, request.signal, apiKey);
  },
};
