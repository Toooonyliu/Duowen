// Public browser configuration contains a provider name and optional WhisperX service URL.
// Per-job access tokens are capabilities returned by that service, never URL parameters.
const DEFAULT_POLL_MS = 1200;
const DEFAULT_JOB_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_READINESS_TIMEOUT_MS = 4 * 60 * 1000;
const DEEPGRAM_DIRECT_UPLOAD_BYTES = 4 * 1024 * 1024;
let deepgramMaxUploadBytes = DEEPGRAM_DIRECT_UPLOAD_BYTES;

function failure(message, code, name = 'Error') {
  const error = new Error(message);
  error.name = name;
  error.code = code;
  return error;
}
function abortError(message = 'Cancellation requested.') { return failure(message, 'ABORTED', 'AbortError'); }
function serverCancelledError() {
  const error = failure('Transcription was cancelled by the service.', 'SERVER_CANCELLED', 'AbortError');
  error.cancellationConfirmed = true;
  return error;
}
function isNumber(value) { return typeof value === 'number' && Number.isFinite(value); }
function bounded(value, fallback, minimum, maximum) {
  return isNumber(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}
function runtimeConfiguration() {
  const declared = typeof window !== 'undefined' ? window.__DUOWEN_CONFIG__ || {} : {};
  const provider = declared.transcriptionProvider || import.meta.env?.VITE_TRANSCRIPTION_PROVIDER || 'whisperx';
  const envUrl = import.meta.env?.VITE_TRANSCRIPTION_API_URL;
  const value = declared.transcriptionBackendUrl || declared.backendUrl || envUrl || '';
  let backendUrl = '', configurationError = '';
  if (declared.mode && !['cloud', 'server', 'whisperx'].includes(declared.mode)) {
    configurationError = 'This version uses the WhisperX cloud service. Browser transcription is not enabled.';
  } else if (!String(value).trim()) {
    configurationError = 'The WhisperX service is not connected yet. Automatic transcription will be available once the service is configured.';
  } else {
    try {
      const url = new URL(String(value).trim(), typeof document !== 'undefined' ? document.baseURI : undefined);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      if (typeof location !== 'undefined' && location.protocol === 'https:' && url.protocol !== 'https:') throw new Error();
      backendUrl = url.href.replace(/\/+$/, '');
    } catch { configurationError = 'The WhisperX service address is invalid. Please reconnect the service.'; }
  }
  return {
    provider, backendUrl, configurationError,
    pollMs: bounded(declared.transcriptionPollMs, DEFAULT_POLL_MS, 500, 10_000),
    jobTimeoutMs: bounded(declared.transcriptionTimeoutMs, DEFAULT_JOB_TIMEOUT_MS, 1000, 4 * DEFAULT_JOB_TIMEOUT_MS),
    uploadTimeoutMs: bounded(declared.uploadTimeoutMs, DEFAULT_UPLOAD_TIMEOUT_MS, 1000, DEFAULT_JOB_TIMEOUT_MS),
    requestTimeoutMs: bounded(declared.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 1000, 60_000),
    readinessTimeoutMs: bounded(declared.transcriptionReadinessTimeoutMs, DEFAULT_READINESS_TIMEOUT_MS, 1000, 5 * 60 * 1000),
    readinessPollMs: bounded(declared.transcriptionReadinessPollMs, 3000, 500, 10_000),
  };
}

export function getTranscriptionMode() {
  const config = runtimeConfiguration();
  if (config.provider === 'deepgram') {
    return { engine: 'deepgram', location: 'server', label: 'Deepgram Nova-3', configured: true, maxUploadBytes: deepgramMaxUploadBytes };
  }
  return { engine: 'whisperx', location: 'server', label: 'WhisperX cloud', configured: Boolean(config.backendUrl), configurationError: config.configurationError };
}
function requiredConfiguration() {
  const config = runtimeConfiguration();
  if (!config.backendUrl) throw failure(config.configurationError, 'BACKEND_NOT_CONFIGURED');
  return config;
}
function emit(callback, progress) {
  // A rendering callback must not leave a network operation unresolved if it throws.
  try { callback?.(progress); } catch { /* The eventual result still resolves the operation. */ }
}
function checkedJob(job) {
  if (!job || typeof job.id !== 'string' || !job.id || job.id.length > 256 ||
      typeof job.accessToken !== 'string' || !job.accessToken || /\s/.test(job.accessToken) || job.accessToken.length > 1024) {
    throw failure('The service did not return secure transcription job details. Please try again.', 'INVALID_JOB');
  }
  return { id: job.id, accessToken: job.accessToken };
}
function jobUrl(config, job) { return config.backendUrl + '/api/jobs/' + encodeURIComponent(job.id); }
function safeMessage(payload, fallback) {
  const detail = typeof payload?.error === 'string' ? payload.error : typeof payload?.error?.message === 'string' ? payload.error.message : payload?.detail;
  return typeof detail === 'string' && detail.trim() ? detail.trim().slice(0, 500) : fallback;
}
function statusError(status, payload, service = 'WhisperX') {
  const messages = {
    400: 'This recording could not be processed. Try another audio format.',
    401: 'Access to this transcription could not be verified. Please upload the original file again.',
    403: 'Access to this transcription could not be verified. Please upload the original file again.',
    404: 'This transcription is no longer available on the service. Please upload the original file again.',
    410: 'This transcription is no longer available on the service. Please upload the original file again.',
    413: 'This file exceeds the service upload limit. Please use a shorter recording.',
    415: 'The service does not support this file format. Try MP3, M4A or WAV.',
    429: 'The transcription service is busy. Please wait and try again.',
    503: `The ${service} service is starting or unavailable. Please try again shortly.`,
  };
  const error = failure(safeMessage(payload, messages[status] || 'The transcription service could not complete this request. Please try again.'), 'HTTP_' + status);
  error.status = status;
  return error;
}
function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', stopped); resolve(); };
    const timer = setTimeout(done, ms);
    const stopped = () => { clearTimeout(timer); signal?.removeEventListener('abort', stopped); reject(abortError()); };
    signal?.addEventListener('abort', stopped, { once: true });
  });
}
function scope(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const forward = () => controller.abort();
  if (signal?.aborted) forward();
  else signal?.addEventListener('abort', forward, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  return { signal: controller.signal, timedOut: () => timedOut, close() { clearTimeout(timer); signal?.removeEventListener('abort', forward); } };
}

export async function checkDeepgramAvailability() {
  const request = scope(undefined, 10_000);
  try {
    const response = await fetch('/api/deepgram', { headers: { Accept: 'application/json' }, cache: 'no-store', signal: request.signal });
    const status = await response.json();
    deepgramMaxUploadBytes = bounded(status?.maxUploadBytes, DEEPGRAM_DIRECT_UPLOAD_BYTES, DEEPGRAM_DIRECT_UPLOAD_BYTES, 100 * 1024 * 1024);
    return { configured: response.ok && status?.configured === true, maxUploadBytes: deepgramMaxUploadBytes };
  } catch {
    return { configured: false, maxUploadBytes: deepgramMaxUploadBytes };
  } finally {
    request.close();
  }
}

async function waitUntilReady(config, signal, onProgress) {
  const readiness = scope(signal, config.readinessTimeoutMs);
  let waitingForSlot = false;
  const report = () => emit(onProgress, { stage: 'queued', detail: waitingForSlot ? 'Waiting for available slot…' : 'Starting WhisperX service…' });
  report();
  try {
    while (true) {
      if (readiness.signal.aborted) throw abortError();
      const request = scope(readiness.signal, config.requestTimeoutMs);
      let response, payload, networkError;
      try {
        response = await fetch(config.backendUrl + '/api/health', { headers: { Accept: 'application/json' }, signal: request.signal, cache: 'no-store', credentials: 'omit' });
        try { payload = await response.json(); } catch { /* Sleeping hosts can return an HTML 503 page. */ }
      } catch (error) { networkError = error; }
      finally { request.close(); }
      if (readiness.signal.aborted) throw abortError();
      if (response?.ok) {
        if (payload?.status !== 'ok' || payload?.engine !== 'whisperx' || typeof payload.acceptingJobs !== 'boolean') {
          throw failure('This address does not expose the Duowen WhisperX API. Please check the service configuration.', 'BACKEND_CONFIGURATION_ERROR');
        }
        if (payload.acceptingJobs) return;
        waitingForSlot = true;
      } else if (!networkError && ![502, 503, 504].includes(response?.status)) {
        if ([401, 403, 404].includes(response?.status)) {
          const error = failure('The WhisperX service health endpoint is unavailable or private. Please check the service address and access settings.', 'BACKEND_CONFIGURATION_ERROR');
          error.status = response.status;
          throw error;
        }
        throw statusError(response.status, payload);
      } else waitingForSlot = false;
      report();
      const retryHeader = response?.headers?.get('Retry-After');
      const retryAfter = retryHeader && Number.isFinite(Number(retryHeader)) ? bounded(Number(retryHeader) * 1000, config.readinessPollMs, 500, 15_000) : config.readinessPollMs;
      await delay(retryAfter, readiness.signal);
    }
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (readiness.timedOut()) throw failure(waitingForSlot ? 'The WhisperX service is still busy. No audio was uploaded; please try again shortly.' : 'The WhisperX service did not start in time. No audio was uploaded; please try again shortly.', 'SERVICE_READINESS_TIMEOUT', 'TimeoutError');
    throw error;
  } finally { readiness.close(); }
}

function uploadFile(file, config, signal, onProgress, synchronous = false) {
  if (signal.aborted) return Promise.reject(abortError());
  const service = synchronous ? 'Deepgram' : 'WhisperX';
  const detail = `Uploading recording to ${service}…`;
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', stopped);
      error ? reject(error) : resolve(value);
    };
    const stopped = () => { request.abort(); finish(abortError()); };
    request.open('POST', synchronous ? '/api/deepgram' : config.backendUrl + '/api/jobs', true);
    request.timeout = config.uploadTimeoutMs;
    request.withCredentials = false;
    request.setRequestHeader('Accept', 'application/json');
    request.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0) {
        emit(onProgress, { stage: 'uploading', percent: Math.min(100, Math.round(event.loaded / event.total * 100)), detail });
      } else emit(onProgress, { stage: 'uploading', detail });
    };
    if (synchronous) {
      request.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      request.upload.onload = () => emit(onProgress, { stage: 'transcribing', detail: 'Waiting for Deepgram to return the transcript…' });
    }
    request.onload = () => {
      let payload;
      try { payload = JSON.parse(request.responseText); } catch { /* Status-specific fallback below. */ }
      if (request.status < 200 || request.status >= 300) return finish(statusError(request.status, payload, service));
      if (!payload || typeof payload !== 'object') return finish(failure('The service returned an unreadable upload response. Please try again.', 'INVALID_RESPONSE'));
      finish(null, payload);
    };
    request.onerror = () => finish(failure(synchronous ? 'The connection was interrupted before a transcript arrived. Check your connection and try again.' : 'The upload connection was interrupted before a job was confirmed. Check your connection and try again.', 'UPLOAD_NETWORK_ERROR'));
    request.ontimeout = () => finish(failure(synchronous ? 'Deepgram did not return a transcript in time. Try again with a shorter recording.' : 'The upload took too long. Check your connection or try a smaller recording.', 'UPLOAD_TIMEOUT', 'TimeoutError'));
    request.onabort = () => finish(abortError());
    signal.addEventListener('abort', stopped, { once: true });
    emit(onProgress, { stage: 'uploading', percent: 0, detail });
    try {
      if (synchronous) request.send(file);
      else {
        const form = new FormData();
        form.append('file', file, file.name || 'recording');
        form.append('language', 'auto');
        request.send(form);
      }
    } catch { finish(failure('The recording could not be uploaded. Check the service connection and try again.', 'UPLOAD_NETWORK_ERROR')); }
  });
}

async function requestStatus(config, job, signal, reconnecting) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const request = scope(signal, config.requestTimeoutMs);
    let response, payload, networkError;
    try {
      response = await fetch(jobUrl(config, job), { headers: { Accept: 'application/json', Authorization: 'Bearer ' + job.accessToken }, signal: request.signal, cache: 'no-store', credentials: 'omit' });
      try { payload = await response.json(); } catch { /* Reject malformed successful responses below. */ }
    } catch (error) { networkError = error; }
    finally { request.close(); }
    if (signal.aborted) throw abortError();
    if (response?.ok) {
      if (!payload || typeof payload !== 'object') throw failure('The service returned an unreadable transcription status. Please try again.', 'INVALID_RESPONSE');
      return payload;
    }
    const retryable = networkError || [408, 429, 500, 502, 503, 504].includes(response?.status);
    if (!retryable || attempt === 3) {
      if (networkError) throw failure('Connection to WhisperX was lost. The job may still be processing; reconnect to check its status.', 'STATUS_NETWORK_ERROR');
      throw statusError(response.status, payload);
    }
    reconnecting();
    const retryHeader = response?.headers?.get('Retry-After');
    const retryAfter = retryHeader && Number.isFinite(Number(retryHeader)) ? Math.min(30_000, Number(retryHeader) * 1000) : 1000 * 2 ** attempt;
    await delay(Math.max(500, retryAfter), signal);
  }
}
function progressFromStatus(payload, job) {
  const aliases = { 'loading-model': 'model-loading', loading: 'model-loading', processing: 'transcribing' };
  const allowed = ['uploading', 'queued', 'model-loading', 'decoding', 'transcribing', 'aligning', 'diarizing', 'cancelling'];
  const requested = payload.status === 'cancelling' ? 'cancelling' : aliases[payload.stage] || payload.stage || aliases[payload.status] || payload.status;
  const progress = { stage: allowed.includes(requested) ? requested : 'queued', job };
  if (isNumber(payload.percent)) progress.percent = Math.max(0, Math.min(100, payload.percent));
  if (typeof payload.detail === 'string') progress.detail = payload.detail.slice(0, 500);
  if (isNumber(payload.etaSeconds) && payload.etaSeconds >= 0) progress.etaSeconds = payload.etaSeconds;
  return progress;
}

export function normalizeTranscriptionResult(result, engine = 'whisperx') {
  if (!result || !Array.isArray(result.segments)) throw failure('The service returned an invalid transcript. Please try again.', 'INVALID_RESULT');
  const segments = result.segments.filter(segment => typeof segment.text === 'string' && segment.text.trim()).map((segment, index) => {
    const start = isNumber(segment.start) && segment.start >= 0 ? segment.start : null;
    const end = isNumber(segment.end) && segment.end >= 0 && (start === null || segment.end >= start) ? segment.end : null;
    return { id: segment.id || 'asr-segment-' + index, start, end, text: segment.text.trim(), speakerId: String(segment.speakerId || segment.speaker || 'unassigned') };
  });
  if (!segments.length) throw failure('No speech was detected in this recording. Try a recording with clear speech.', 'NO_SPEECH');
  const speakers = Array.isArray(result.speakers) ? result.speakers.filter(speaker => speaker && speaker.id).map(speaker => ({ id: String(speaker.id), name: String(speaker.name || speaker.label || 'Unknown speaker'), confirmed: speaker.confirmed === true })) : [];
  for (const segment of segments) {
    if (!speakers.some(speaker => speaker.id === segment.speakerId)) speakers.push({ id: segment.speakerId, name: segment.speakerId === 'unassigned' ? 'Unknown speaker' : 'Speaker ' + (speakers.length + 1), confirmed: false });
  }
  return {
    segments, speakers, engine,
    ...(typeof result.language === 'string' ? { language: result.language } : {}),
    ...(isNumber(result.duration) && result.duration > 0 ? { duration: result.duration } : {}),
    timingSource: typeof result.timingSource === 'string' ? result.timingSource : 'asr-segment-approximate',
    diarizationStatus: typeof result.diarizationStatus === 'string' ? result.diarizationStatus : 'not-run',
    reviewStatus: 'uncorrected-asr', asrDraft: true,
  };
}
async function pollJob(config, job, signal, onProgress) {
  let previous = '', lastProgress = { stage: 'queued', job };
  while (true) {
    const payload = await requestStatus(config, job, signal, () => emit(onProgress, { ...lastProgress, detail: 'Reconnecting to WhisperX…' }));
    if (payload.status === 'completed') return normalizeTranscriptionResult(payload.result);
    if (payload.status === 'failed') throw failure(safeMessage(payload, 'WhisperX could not transcribe this recording. Please try again.'), 'TRANSCRIPTION_FAILED');
    if (payload.status === 'cancelled') throw serverCancelledError();
    if (payload.status === 'deleted') throw statusError(410, payload);
    if (!['queued', 'processing', 'running', 'model-loading', 'decoding', 'transcribing', 'aligning', 'diarizing', 'cancelling'].includes(payload.status)) throw failure('The service returned an unknown processing state. Please reconnect and try again.', 'INVALID_STATUS');
    lastProgress = progressFromStatus(payload, job);
    const signature = JSON.stringify(lastProgress);
    if (signature !== previous) { emit(onProgress, lastProgress); previous = signature; }
    await delay(config.pollMs, signal);
  }
}

async function cancelRemoteJob(config, job, signal) {
  const secureJob = checkedJob(job);
  const request = scope(signal, Math.min(config.requestTimeoutMs, 8000));
  try {
    const response = await fetch(jobUrl(config, secureJob), { method: 'DELETE', headers: { Accept: 'application/json', Authorization: 'Bearer ' + secureJob.accessToken }, signal: request.signal, credentials: 'omit' });
    let payload;
    try { payload = await response.json(); } catch { /* HTTP status is still checked. */ }
    if (!response.ok) throw statusError(response.status, payload);
    return payload;
  } finally { request.close(); }
}
/** Explicit cancellation uses only this job's capability, never a global API key. */
export async function cancelTranscriptionJob(job, { signal } = {}) {
  return cancelRemoteJob(requiredConfiguration(), job, signal);
}
async function performJob(start, options, resuming = false) {
  const config = requiredConfiguration();
  const operation = scope(options.signal, config.jobTimeoutMs);
  let job = null;
  try {
    if (operation.signal.aborted) throw abortError();
    job = checkedJob(await start(config, operation.signal));
    if (!resuming) emit(options.onProgress, { stage: 'queued', detail: 'Recording received. Waiting for WhisperX…', job });
    return await pollJob(config, job, operation.signal, options.onProgress);
  } catch (error) {
    if (operation.signal.aborted && job) {
      // The user's cancellation must also reach the server, including after a page resume.
      try { await cancelRemoteJob(config, job); } catch { /* Server cancellation is best effort when offline. */ }
    }
    if (operation.timedOut()) throw failure('Transcription timed out. A cancellation was requested; please retry or use a shorter recording.', 'TRANSCRIPTION_TIMEOUT', 'TimeoutError');
    if (operation.signal.aborted) throw abortError();
    throw error;
  } finally { operation.close(); }
}

async function deepgramUploadAction(action, data, signal) {
  const response = await fetch('/api/deepgram', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ action, ...data }), signal,
  });
  if (response.status === 204) return;
  const result = await response.json().catch(() => null);
  if (!response.ok) throw statusError(response.status, result, 'Deepgram');
  if (!result) throw failure('Deepgram returned an unreadable response.', 'INVALID_RESPONSE');
  return result;
}

async function transcribeLargeDeepgramFile(file, config, { signal, onProgress }) {
  const upload = scope(signal, config.uploadTimeoutMs);
  let capability;
  try {
    const contentType = file.type || 'application/octet-stream';
    const authorized = await deepgramUploadAction('authorize', { contentType, size: file.size }, upload.signal);
    capability = authorized.capability;
    const { put } = await import('@vercel/blob/client');
    await put(authorized.pathname, file, {
      access: 'private', token: authorized.clientToken, contentType, abortSignal: upload.signal,
      onUploadProgress: ({ percentage }) => emit(onProgress, { stage: 'uploading', percent: percentage, detail: 'Uploading recording…' }),
    });
    upload.signal.throwIfAborted();
    upload.close();
    emit(onProgress, { stage: 'transcribing', detail: 'Waiting for Deepgram to return the transcript…' });
    const processing = scope(signal, 300_000);
    try { return await deepgramUploadAction('transcribe', { capability }, processing.signal); }
    catch (error) {
      if (processing.timedOut()) throw failure('Deepgram did not return a transcript in time.', 'PROVIDER_TIMEOUT');
      throw error;
    }
    finally { processing.close(); }
  } catch (error) {
    if (capability) void deepgramUploadAction('cancel', { capability }, AbortSignal.timeout(10_000)).catch(() => {});
    if (upload.timedOut()) throw failure('The upload took too long. Try again with a faster connection.', 'UPLOAD_TIMEOUT');
    if (signal?.aborted) throw abortError();
    throw error;
  } finally {
    upload.close();
  }
}

export function transcribeFile(file, options = {}) {
  if (!file || typeof file.arrayBuffer !== 'function' || !Number.isFinite(file.size) || file.size <= 0) return Promise.reject(failure('Choose a non-empty audio or video file.', 'INVALID_FILE'));
  const config = runtimeConfiguration();
  if (config.provider === 'deepgram') {
    if (file.size > deepgramMaxUploadBytes) return Promise.reject(failure(`This version supports files up to ${deepgramMaxUploadBytes / 1024 ** 2} MiB.`, 'FILE_TOO_LARGE'));
    const result = file.size > DEEPGRAM_DIRECT_UPLOAD_BYTES
      ? transcribeLargeDeepgramFile(file, config, options)
      : uploadFile(file, config, options.signal || new AbortController().signal, options.onProgress, true);
    return result.then(value => normalizeTranscriptionResult(value, 'deepgram'));
  }
  return performJob(async (config, signal) => {
    await waitUntilReady(config, signal, options.onProgress);
    return uploadFile(file, config, signal, options.onProgress);
  }, options);
}

/** Resume an existing cloud job after refresh without asking for the audio again. */
export function resumeTranscription(job, options = {}) {
  return performJob(async () => checkedJob(job), options, true);
}
