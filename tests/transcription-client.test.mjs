import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { File } from 'node:buffer';
import { transcribeFile, resumeTranscription, cancelTranscriptionJob, getTranscriptionMode, normalizeTranscriptionResult } from '../src/transcription-client.js';

// The adapter is exercised over actual HTTP. This fixture server deliberately does
// not perform ASR; model/inference validation belongs to the WhisperX service tests.
const accessToken = 'test-job-capability-abcdefghijklmnopqrstuvwxyz';
const result = { segments: [{ start: 0.42, end: 2.6, text: '  实际服务返回的文字。 ', speakerId: 'unassigned' }], speakers: [{ id: 'unassigned', name: 'Unknown speaker', confirmed: false }], language: 'zh', duration: 3, timingSource: 'whisperx-aligned', diarizationStatus: 'not-run' };
let origin, server, trace = [], polls = 0, healthChecks = 0, behavior = 'complete', healthBehavior = 'ready', xhrCount = 0;

class HttpUploadXHR {
  constructor() { this.upload = {}; this.headers = {}; this.controller = new AbortController(); xhrCount++; }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(key, value) { this.headers[key] = value; }
  send(body) {
    this.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 });
    fetch(this.url, { method: this.method, headers: this.headers, body, signal: this.controller.signal }).then(async response => {
      this.status = response.status;
      this.responseText = await response.text();
      this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
      this.onload?.();
    }).catch(error => { if (error.name !== 'AbortError') this.onerror?.(); });
  }
  abort() { this.controller.abort(); this.onabort?.(); }
}

function configure(overrides = {}) {
  globalThis.window = { __DUOWEN_CONFIG__: { transcriptionBackendUrl: origin, transcriptionPollMs: 500, transcriptionReadinessPollMs: 500, ...overrides } };
  trace = []; polls = 0; healthChecks = 0; behavior = 'complete'; healthBehavior = 'ready'; xhrCount = 0;
}
function audioFile() { return new File(['not-a-sample-library-file'], 'a-new-upload.wav', { type: 'audio/wav' }); }

before(async () => {
  globalThis.XMLHttpRequest = HttpUploadXHR;
  server = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    trace.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/health') {
      healthChecks++;
      if (healthBehavior === 'cold' || healthBehavior === 'cold-once' && healthChecks === 1) {
        response.statusCode = 503; response.setHeader('Content-Type', 'text/html');
        return response.end('<html>Space is waking up</html>');
      }
      if (['401', '404', '500'].includes(healthBehavior)) { response.statusCode = Number(healthBehavior); return response.end('{}'); }
      if (healthBehavior === 'wrong-api') return response.end(JSON.stringify({ status: 'ok', app: 'unrelated service' }));
      return response.end(JSON.stringify({ status: 'ok', engine: 'whisperx', acceptingJobs: healthBehavior !== 'busy' || healthChecks > 1 }));
    }
    if (request.method === 'POST') {
      if (behavior === 'too-large') { response.statusCode = 413; return response.end(JSON.stringify({ detail: 'This audio exceeds the configured upload limit.' })); }
      return response.end(JSON.stringify({ id: 'secure-job-1', ...(behavior === 'missing-token' ? {} : { accessToken }), status: 'queued' }));
    }
    if (request.headers.authorization !== 'Bearer ' + accessToken) { response.statusCode = 401; return response.end('{}'); }
    if (request.method === 'DELETE') return response.end(JSON.stringify({ status: behavior === 'cancelling' ? 'cancelling' : 'cancelled' }));
    polls++;
    if (behavior === 'decode-failed') return response.end(JSON.stringify({ status: 'failed', detail: 'Transcription failed', error: 'This recording could not be decoded. Try MP3, M4A or WAV.' }));
    if (behavior === 'cancelling') return response.end(JSON.stringify(polls === 1 ? { status: 'cancelling', stage: 'transcribing', detail: 'Stopping worker' } : { status: 'cancelled' }));
    if (behavior === 'retry' && polls === 1) { response.statusCode = 503; return response.end(JSON.stringify({ detail: 'Starting worker' })); }
    if (behavior === 'pending') return response.end(JSON.stringify({ status: 'processing', stage: 'transcribing', percent: 17, detail: 'Transcribing speech' }));
    if (behavior === 'resumed' || (behavior === 'retry' && polls > 1) || polls >= 3) return response.end(JSON.stringify({ status: 'completed', result }));
    response.end(JSON.stringify(polls === 1 ? { status: 'queued', stage: 'queued', detail: 'Waiting in queue' } : { status: 'processing', stage: 'transcribing', percent: 34, detail: 'Transcribing speech' }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  delete globalThis.window; delete globalThis.XMLHttpRequest;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

test('an unconfigured service rejects before sending any audio or fabricating a transcript', async () => {
  configure(); window.__DUOWEN_CONFIG__ = {};
  assert.equal(getTranscriptionMode().location, 'server');
  assert.equal(getTranscriptionMode().configured, false);
  await assert.rejects(transcribeFile(audioFile()), { code: 'BACKEND_NOT_CONFIGURED' });
  assert.equal(xhrCount, 0); assert.equal(trace.length, 0);
});

test('a new file is uploaded and authenticated job progress produces the actual API transcript', async () => {
  configure(); const progress = [];
  const transcript = await transcribeFile(audioFile(), { onProgress: event => progress.push(event) });
  assert.equal(transcript.segments[0].text, '实际服务返回的文字。');
  assert.equal(transcript.segments[0].start, 0.42);
  assert.equal(transcript.engine, 'whisperx');
  assert.equal(transcript.diarizationStatus, 'not-run');
  assert.equal(transcript.accessToken, undefined);
  assert.ok(progress.some(event => event.stage === 'uploading' && event.percent === 25));
  assert.ok(progress.some(event => event.stage === 'queued' && event.job?.accessToken === accessToken));
  assert.ok(progress.some(event => event.stage === 'transcribing' && event.percent === 34));
  assert.equal(trace[0].url, '/api/health');
  assert.match(trace.find(request => request.method === 'POST').body, /a-new-upload\.wav/);
  assert.match(trace.find(request => request.method === 'POST').body, /not-a-sample-library-file/);
  assert.equal(trace.filter(request => request.method === 'POST').length, 1);
  assert.ok(trace.filter(request => request.url.startsWith('/api/jobs/')).every(request => request.authorization === 'Bearer ' + accessToken));
  assert.equal(trace[0].authorization, undefined);
  assert.ok(trace.every(request => !request.url.includes(accessToken)));
});

test('refresh recovery resumes with the per-job capability without reuploading audio', async () => {
  configure(); behavior = 'resumed';
  const transcript = await resumeTranscription({ id: 'secure-job-1', accessToken });
  assert.equal(transcript.segments.length, 1);
  assert.equal(xhrCount, 0);
  assert.deepEqual(trace.map(request => request.method), ['GET']);
  assert.equal(healthChecks, 0);
});

test('cancelling an active request sends DELETE to the server, then rejects as aborted', async () => {
  configure(); behavior = 'pending';
  const controller = new AbortController();
  await assert.rejects(transcribeFile(audioFile(), { signal: controller.signal, onProgress: event => { if (event.stage === 'transcribing') controller.abort(); } }), error => error.name === 'AbortError' && error.code === 'ABORTED' && error.cancellationConfirmed !== true);
  const deleted = trace.filter(request => request.method === 'DELETE');
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].authorization, 'Bearer ' + accessToken);
});

test('a disconnected status request is retried without uploading a duplicate billable job', async () => {
  configure(); behavior = 'retry'; const progress = [];
  const transcript = await transcribeFile(audioFile(), { onProgress: event => progress.push(event) });
  assert.equal(transcript.segments.length, 1);
  assert.equal(trace.filter(request => request.method === 'POST').length, 1);
  assert.equal(trace.filter(request => request.url.startsWith('/api/jobs/') && request.method === 'GET').length, 2);
  assert.ok(progress.some(event => event.detail === 'Reconnecting to WhisperX…'));
});

test('the overall processing deadline cancels the server job and provides a recoverable timeout', async () => {
  configure({ transcriptionTimeoutMs: 1000 }); behavior = 'pending';
  await assert.rejects(transcribeFile(audioFile()), { name: 'TimeoutError', code: 'TRANSCRIPTION_TIMEOUT' });
  assert.equal(trace.filter(request => request.method === 'DELETE').length, 1);
});

test('upload rejection and missing secure job details never start polling or report ready', async () => {
  configure(); behavior = 'too-large';
  await assert.rejects(transcribeFile(audioFile()), { code: 'HTTP_413' });
  assert.deepEqual(trace.map(request => request.method), ['GET', 'POST']);
  configure(); behavior = 'missing-token';
  await assert.rejects(transcribeFile(audioFile()), { code: 'INVALID_JOB' });
  assert.deepEqual(trace.map(request => request.method), ['GET', 'POST']);
});

test('a sleeping service returns HTML 503, becomes healthy, then receives exactly one upload', async () => {
  configure(); healthBehavior = 'cold-once'; behavior = 'resumed'; const progress = [];
  const transcript = await transcribeFile(audioFile(), { onProgress: event => progress.push(event) });
  assert.equal(transcript.engine, 'whisperx');
  assert.equal(healthChecks, 2);
  assert.deepEqual(trace.slice(0, 3).map(request => [request.method, request.url]), [['GET', '/api/health'], ['GET', '/api/health'], ['POST', '/api/jobs']]);
  assert.equal(trace.filter(request => request.method === 'POST').length, 1);
  assert.ok(progress.some(event => event.stage === 'queued' && event.detail === 'Starting WhisperX service…' && event.percent === undefined));
});

test('cancellation while the service is waking stops waiting without uploading any audio', async () => {
  configure(); healthBehavior = 'cold'; const controller = new AbortController(); let queuedEvents = 0;
  await assert.rejects(transcribeFile(audioFile(), { signal: controller.signal, onProgress: event => {
    if (event.stage === 'queued' && ++queuedEvents === 2) controller.abort();
  } }), { name: 'AbortError', code: 'ABORTED' });
  assert.equal(healthChecks, 1);
  assert.equal(xhrCount, 0);
  assert.ok(trace.every(request => request.url === '/api/health'));
});

test('a full queue waits for a real available slot before creating a job', async () => {
  configure(); healthBehavior = 'busy'; behavior = 'resumed'; const progress = [];
  await transcribeFile(audioFile(), { onProgress: event => progress.push(event) });
  assert.equal(healthChecks, 2);
  assert.equal(trace.filter(request => request.method === 'POST').length, 1);
  assert.ok(progress.some(event => event.stage === 'queued' && event.detail === 'Waiting for available slot…' && event.percent === undefined));
});

test('missing, private and unrelated health APIs fail promptly without retrying an upload', async () => {
  for (const value of ['401', '404', 'wrong-api']) {
    configure(); healthBehavior = value;
    await assert.rejects(transcribeFile(audioFile()), { code: 'BACKEND_CONFIGURATION_ERROR' });
    assert.equal(healthChecks, 1);
    assert.equal(xhrCount, 0);
  }
  configure(); healthBehavior = '500';
  await assert.rejects(transcribeFile(audioFile()), { code: 'HTTP_500' });
  assert.equal(healthChecks, 1);
  assert.equal(xhrCount, 0);
});

test('service cold-start waiting has a bounded deadline and never uploads on timeout', async () => {
  configure({ transcriptionReadinessTimeoutMs: 1000 }); healthBehavior = 'cold';
  await assert.rejects(transcribeFile(audioFile()), { name: 'TimeoutError', code: 'SERVICE_READINESS_TIMEOUT' });
  assert.ok(healthChecks >= 1);
  assert.equal(xhrCount, 0);
  assert.ok(trace.every(request => request.url === '/api/health'));
});

test('accepted cancellation keeps polling until the server confirms terminal cancellation', async () => {
  configure(); behavior = 'cancelling'; const job = { id: 'secure-job-1', accessToken }, progress = [];
  assert.deepEqual(await cancelTranscriptionJob(job), { status: 'cancelling' });
  await assert.rejects(resumeTranscription(job, { onProgress: event => progress.push(event) }), { name: 'AbortError', code: 'SERVER_CANCELLED', cancellationConfirmed: true });
  assert.equal(polls, 2);
  assert.ok(progress.some(event => event.stage === 'cancelling' && event.detail === 'Stopping worker'));
  assert.equal(healthChecks, 0);
  assert.equal(xhrCount, 0);
});

test('a failed job preserves the actionable service error instead of its generic status label', async () => {
  configure(); behavior = 'decode-failed';
  await assert.rejects(resumeTranscription({ id: 'secure-job-1', accessToken }), {
    code: 'TRANSCRIPTION_FAILED', message: 'This recording could not be decoded. Try MP3, M4A or WAV.',
  });
});

test('untimed ASR text stays untimed, and an empty speech result is not a completed transcript', () => {
  const transcript = normalizeTranscriptionResult({ segments: [{ text: 'heard words', start: null, end: null }] });
  assert.equal(transcript.segments[0].start, null);
  assert.equal(transcript.segments[0].end, null);
  assert.deepEqual(transcript.speakers, [{ id: 'unassigned', name: 'Unknown speaker', confirmed: false }]);
  assert.throws(() => normalizeTranscriptionResult({ segments: [] }), { code: 'NO_SPEECH' });
});
