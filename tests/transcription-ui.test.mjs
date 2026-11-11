import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { parseAst } from 'rollup/parseAst';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const ast = parseAst(source);

// main.js initializes the DOM and imports CSS, so execute its actual declarations
// in an isolated context. Rendering/browser effects are inert here; the queue,
// persistence, cancellation, normalization, markup and click handler stay real.
// Only the ASR client boundary controls when processing succeeds or fails.
const variableNames = new Set([
  'STORAGE_KEY', 'esc', 'uid', 'clone', 'icon', 'formatTime', 'state',
  'localFiles', 'transcriptionQueue', 'transcriptionJobs', 'activeTranscription',
  'activeStages', 'icons',
]);
const functionNames = new Set([
  'transcriptionMode', 'isTranscribing', 'elapsedLabel', 'progressLabel',
  'recordById', 'hasUnassignedSegments', 'status', 'normalize', 'persist',
  'queueTranscription', 'pumpTranscriptionQueue', 'cancelTranscription',
  'confirmTranscriptionCancellation', 'cancelAllTranscriptions',
  'rememberUndo', 'restoreUndo', 'missingTranscript', 'processingVisual',
  'processingMarkup', 'cancellationActions', 'cancellationRetention',
  'addPendingFiles',
]);
const declarations = ast.body.filter(node => {
  if (node.type === 'FunctionDeclaration') return functionNames.has(node.id.name);
  return node.type === 'VariableDeclaration' && node.declarations.some(item => variableNames.has(item.id.name));
});
const clickListener = ast.body.find(node =>
  node.type === 'ExpressionStatement' &&
  node.expression.type === 'CallExpression' &&
  node.expression.callee?.object?.name === 'document' &&
  node.expression.callee?.property?.name === 'addEventListener' &&
  node.expression.arguments[0]?.value === 'click'
);
assert.ok(clickListener, 'The actual recording click handler must be present.');
const clickHandler = clickListener.expression.arguments[1];
const harnessSource = [
  ...declarations.map(node => source.slice(node.start, node.end)),
  `globalThis.handleClick = ${source.slice(clickHandler.start, clickHandler.end)};`,
].join('\n');

const fixtureResult = {
  segments: [{ start: 0, end: 2, text: 'We chose Tuesday.', speakerId: 'unassigned' }],
  speakers: [{ id: 'unassigned', name: 'Unknown speaker', confirmed: false }],
  duration: 2,
  engine: 'whisperx',
};
const settle = () => new Promise(setImmediate);
const serviceCancellation = () => Object.assign(new Error('Server confirmed cancellation.'), {
  name: 'AbortError', code: 'SERVER_CANCELLED', cancellationConfirmed: true,
});

function createHarness() {
  let saved = null;
  let cancellation = async () => ({ status: 'cancelled' });
  const requests = [];
  const cancellationRequests = [];
  const navigation = [];
  const intervals = new Set();

  function beginRequest(kind, file, existingJob, options) {
    const job = existingJob || {
      id: 'test-job-' + (requests.length + 1),
      accessToken: 'test-only-job-capability',
    };
    options.onProgress({ stage: 'transcribing', job, percent: 25 });
    return new Promise((resolve, reject) => {
      const stop = () => request.reject(Object.assign(new Error('Local request aborted.'), {
        name: 'AbortError', code: 'ABORTED',
      }));
      const request = {
        kind, file, job,
        resolve(result) {
          options.signal.removeEventListener('abort', stop);
          resolve(result);
        },
        reject(error) {
          options.signal.removeEventListener('abort', stop);
          reject(error);
        },
      };
      requests.push(request);
      options.signal.addEventListener('abort', stop, { once: true });
    });
  }

  const context = vm.createContext({
    crypto: webcrypto,
    AbortController,
    URL: { createObjectURL: () => 'blob:test-audio' },
    localStorage: { setItem: (_key, value) => { saved = JSON.parse(value); } },
    window: { getSelection: () => ({ toString: () => '' }) },
    getTranscriptionMode: () => ({ configured: true, engine: 'whisperx', location: 'server' }),
    transcribeFile: (file, options) => beginRequest('upload', file, null, options),
    resumeTranscription: (job, options) => beginRequest('resume', null, job, options),
    cancelTranscriptionJob: job => {
      cancellationRequests.push(job);
      return cancellation(job);
    },
    setInterval: callback => { intervals.add(callback); return callback; },
    clearInterval: callback => intervals.delete(callback),
    audioMetadata: async () => ({ duration: 90, error: false }),
    navigate: id => navigation.push(id),
    closeDialog() {},
    render() {},
    refreshTranscriptionViews() {},
    notify() {},
  });
  vm.runInContext(harnessSource, context, { filename: 'transcription-ui-main.js' });
  const app = vm.runInContext(`({
    state, localFiles, queueTranscription, normalize, persist, rememberUndo,
    restoreUndo, status, cancelTranscription, processingMarkup,
    cancellationActions, missingTranscript, addPendingFiles,
    get activeTranscription() { return activeTranscription; }
  })`, context);

  return {
    app, requests, cancellationRequests, navigation, intervals,
    get saved() { return saved; },
    setCancellation(operation) { cancellation = operation; },
    click: event => context.handleClick(event),
    recording(id, overrides = {}) {
      return app.normalize({
        id, title: 'Meeting', originalFilename: 'meeting.mp3',
        source: 'local-upload', status: 'queued', audioUrl: 'blob:test-audio',
        segments: [], speakers: [], notes: {}, qa: [], ...overrides,
      }, 0);
    },
    cloudRecording(id) {
      return this.recording(id, {
        audioUrl: null,
        status: 'transcribing',
        transcription: {
          status: 'processing',
          job: { id: 'test-job-' + id, accessToken: 'test-only-job-capability' },
        },
      });
    },
  };
}

function clickEvent(recordingId, { interactive = false, ...overrides } = {}) {
  const card = { dataset: { recordingCard: recordingId } };
  return {
    button: 0,
    preventDefault() {},
    target: {
      closest(selector) {
        if (selector === '[data-recording-card]') return card;
        if (interactive && selector === 'button,a,input,select,textarea,label,[contenteditable]') return {};
        return null;
      },
    },
    ...overrides,
  };
}

function cancellationButtonIsDisabled(markup) {
  return /data-action="cancel-transcription"[^>]* disabled/.test(markup);
}

test('upload starts real transcription automatically and the card surface opens its recording', async () => {
  const harness = createHarness();
  const { app } = harness;
  const file = { name: 'unseen-meeting.mp3', size: 900, type: 'audio/mpeg' };
  app.state.pendingFiles = [file];
  app.addPendingFiles();

  const recording = app.state.recordings[0];
  assert.equal(app.state.recordings.length, 1);
  assert.equal(harness.navigation[0], recording.id, 'A single upload opens straight into its recording.');
  assert.equal(harness.requests.length, 1, 'Uploading must invoke the actual processing queue.');
  assert.equal(harness.requests[0].kind, 'upload');
  assert.equal(harness.requests[0].file, file);
  assert.equal(app.status(recording).key, 'transcribing');
  assert.equal(recording.segments.length, 0, 'A pending recording must not contain fabricated transcript text.');
  assert.match(app.processingMarkup(recording), /Transcribing/);
  assert.doesNotMatch(app.processingMarkup(recording), /import-transcript|Add transcript/);
  assert.doesNotMatch(app.missingTranscript(recording), /import-transcript|Add transcript/);

  await harness.click(clickEvent(recording.id));
  assert.equal(harness.navigation.at(-1), recording.id, 'Blank card space must open the recording.');

  const count = harness.navigation.length;
  await harness.click(clickEvent(recording.id, { interactive: true }));
  await harness.click(clickEvent(recording.id, { metaKey: true }));
  assert.equal(harness.navigation.length, count, 'Native controls and modified clicks keep their own behavior.');

  harness.requests[0].resolve(fixtureResult);
  await settle();
  assert.equal(recording.status, 'ready');
  assert.equal(recording.segments[0].text, fixtureResult.segments[0].text);
  assert.equal(harness.intervals.size, 0);
});

test('cloud lifecycle preserves transcripts and cancellation ownership across undo, errors and refresh', async () => {
  const harness = createHarness();
  const { app } = harness;
  const recording = harness.recording('first');
  app.state.recordings = [recording];
  app.queueTranscription(recording, { name: 'meeting.mp3' });

  assert.equal(recording.status, 'transcribing');
  assert.equal(harness.saved.recordings[0].status, 'transcribing');
  assert.equal(harness.saved.recordings[0].transcription.job.id, harness.requests[0].job.id);
  assert.equal(harness.saved.recordings[0].audioUrl, null);

  // Undoing a concurrent title change must preserve a newly completed transcript.
  app.rememberUndo('Title updated', recording.id);
  recording.title = 'Renamed';
  harness.requests.at(-1).resolve(fixtureResult);
  await settle();
  assert.equal(recording.transcription.status, 'complete');
  assert.equal(recording.transcription.job, undefined);
  app.restoreUndo();
  assert.equal(recording.title, 'Meeting');
  assert.equal(recording.segments[0].text, fixtureResult.segments[0].text);

  // Refresh recovery has no audio object, and must use GET/resume rather than upload.
  const resumed = harness.cloudRecording('resume');
  app.state.recordings = [resumed];
  app.queueTranscription(resumed, null, { resumeJob: resumed.transcription.job });
  assert.equal(harness.requests.at(-1).kind, 'resume');
  assert.equal(harness.requests.filter(request => request.kind === 'upload').length, 1);
  assert.equal(app.status(resumed).key, 'transcribing');
  await app.cancelTranscription(resumed);
  await settle();
  assert.equal(resumed.status, 'cancelled');
  assert.equal(resumed.transcription.job, undefined);
  assert.equal(app.activeTranscription, null);

  // An offline DELETE cannot confirm that a billable cloud worker has stopped.
  const offline = harness.cloudRecording('offline');
  app.state.recordings = [offline];
  app.queueTranscription(offline, null, { resumeJob: offline.transcription.job });
  harness.setCancellation(async () => { throw new TypeError('Network request failed.'); });
  await app.cancelTranscription(offline);
  assert.equal(offline.status, 'cancellation-unconfirmed');
  assert.ok(offline.transcription.job?.accessToken);
  app.persist();
  assert.ok(harness.saved.recordings[0].transcription.job?.accessToken);

  harness.requests.at(-1).reject(Object.assign(new Error('Connection lost.'), { code: 'STATUS_NETWORK_ERROR' }));
  await settle();
  assert.equal(offline.status, 'cancellation-unconfirmed');
  app.queueTranscription(offline, null, { resumeJob: offline.transcription.job });
  assert.equal(harness.requests.at(-1).kind, 'resume');

  // An accepted request is not terminal: keep ownership and polling until confirmed.
  harness.setCancellation(async () => ({ status: 'cancelling' }));
  await app.cancelTranscription(offline);
  assert.equal(offline.status, 'cancelling');
  assert.ok(offline.transcription.job?.accessToken);
  assert.ok(app.activeTranscription);
  harness.requests.at(-1).reject(serviceCancellation());
  await settle();
  assert.equal(offline.status, 'cancelled');
  assert.equal(offline.transcription.job, undefined);

  // Neither a local deadline nor a local AbortError confirms remote cancellation.
  for (const [id, error] of [
    ['deadline', Object.assign(new Error('Local deadline elapsed.'), { code: 'TRANSCRIPTION_TIMEOUT' })],
    ['local-abort', Object.assign(new Error('Local polling stopped.'), { name: 'AbortError', code: 'ABORTED' })],
  ]) {
    const interrupted = harness.cloudRecording(id);
    app.state.recordings = [interrupted];
    app.queueTranscription(interrupted, null, { resumeJob: interrupted.transcription.job });
    harness.requests.at(-1).reject(error);
    await settle();
    assert.equal(interrupted.status, 'cancellation-unconfirmed', id);
    assert.ok(interrupted.transcription.job?.accessToken, id + ' must retain cloud ownership.');
  }

  // Refresh can interrupt DELETE before the server receives it. Only an active
  // HTTP request may disable Retry cancellation, never a persisted waiting state.
  const refreshing = harness.cloudRecording('refresh-cancel');
  refreshing.status = 'cancelling';
  refreshing.transcription.cancelRequestedAt = Date.now();
  refreshing.transcription.cancelRequestInFlight = true;
  app.state.recordings = [refreshing];
  app.persist();
  assert.equal(harness.saved.recordings[0].transcription.cancelRequestInFlight, undefined);
  const restored = app.normalize(harness.saved.recordings[0], 0);
  app.state.recordings = [restored];
  app.queueTranscription(restored, null, { resumeJob: restored.transcription.job });
  assert.equal(restored.status, 'cancelling');
  assert.equal(cancellationButtonIsDisabled(app.cancellationActions(restored)), false);
  assert.match(app.cancellationActions(restored), /Retry cancellation/);

  let finishDelete;
  harness.setCancellation(() => new Promise(resolve => { finishDelete = resolve; }));
  const retry = app.cancelTranscription(restored);
  assert.equal(cancellationButtonIsDisabled(app.cancellationActions(restored)), true);
  finishDelete({ status: 'cancelling' });
  await retry;
  assert.equal(cancellationButtonIsDisabled(app.cancellationActions(restored)), false);
  assert.ok(restored.transcription.job?.accessToken);
  harness.requests.at(-1).reject(serviceCancellation());
  await settle();
  assert.equal(restored.status, 'cancelled');
  assert.equal(restored.transcription.job, undefined);
  assert.equal(app.activeTranscription, null);
  assert.equal(harness.intervals.size, 0);
});
