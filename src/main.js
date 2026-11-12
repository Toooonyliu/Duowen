import '@phosphor-icons/web/regular';
import './styles.css';
import { exportRecording } from './export-client.js';
import { transcribeFile, resumeTranscription, cancelTranscriptionJob, getTranscriptionMode, checkDeepgramAvailability } from './transcription-client.js';
import { groupTranscriptParagraphs, transcriptSegmentSeparator } from './transcript-paragraphs.js';

const STORAGE_KEY = 'fieldnote-demo-v1';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => crypto.randomUUID?.() || String(Date.now()) + Math.random().toString(16).slice(2);
const clone = value => JSON.parse(JSON.stringify(value));
const icon = (name, extra = '') => `<i class="ph ph-${name} ${extra}" aria-hidden="true"></i>`;
const formatTime = value => {
  if (!Number.isFinite(Number(value)) || value === null) return '—';
  const s = Math.max(0, Math.floor(value));
  return (s >= 3600 ? Math.floor(s / 3600) + ':' : '') + (s >= 3600 ? String(Math.floor(s / 60) % 60).padStart(2, '0') : String(Math.floor(s / 60)).padStart(2, '0')) + ':' + String(s % 60).padStart(2, '0');
};
const dateLabel = value => new Intl.DateTimeFormat('en-US', {month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit'}).format(new Date(value));
const dayLabel = value => {
  const date = new Date(value), today = new Date();
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', {month:'short', day:'numeric', ...(date.getFullYear() === today.getFullYear() ? {} : {year:'numeric'})}).format(date);
};
const timeLabel = value => new Intl.DateTimeFormat('en-US', {hour:'numeric', minute:'2-digit'}).format(new Date(value));
const button = (name, label, action, extras = '', cls = '') => `<button type="button" class="icon-button ${cls}" aria-label="${esc(label)}" data-tooltip="${esc(label)}" data-action="${action}" ${extras}>${icon(name)}</button>`;
const root = $('#root');
root.setAttribute('aria-live', 'off');
const audio = document.createElement('audio');
audio.preload = 'metadata';
audio.id = 'demo-audio';
document.body.append(audio);
const state = {
  recordings: [], seed: [], knownSpeakers: [], search: '',
  detailTab: 'transcript', transcriptSearch: '', audioId: null, currentTime: 0,
  playing: false, rate: 1, dialog: null, answer: null, messages: {}, collapsedBatches: new Set(),
  undo: null, loading: true, dragDepth: 0, pendingFiles: [], pendingSeek: null, processing: {},
  libraryScroll: 0, lastView: 'upload', seedSignature: '', exportingFormat: null, deepgramStatus: null,
  follow: true, followedSegment: null, searchIndex: 0,
  projects: [], libraryView: 'date'
};
const localFiles = new Map();
const transcriptionQueue = [];
const transcriptionJobs = new Map();
let activeTranscription = null;
const activeStages = new Set(['queued','uploading','model-loading','decoding','transcribing','aligning','diarizing','cancelling']);
const icons = {ready:'check-circle', partial:'users', 'needs-audio':'link-break', queued:'clock', uploading:'upload-simple', 'model-loading':'circle-notch', decoding:'waveform', transcribing:'waveform', aligning:'crosshair', diarizing:'users', interrupted:'arrow-clockwise', cancelling:'circle-notch', 'cancellation-unconfirmed':'warning-circle', cancelled:'pause-circle', error:'warning-circle'};
function transcriptionMode() {
  const mode = getTranscriptionMode();
  if (mode.engine !== 'deepgram') return mode;
  const status = state.deepgramStatus;
  const maxUploadBytes = status?.maxUploadBytes ?? mode.maxUploadBytes;
  return {
    ...mode,
    configured: status?.configured === true,
    checking: status === null,
    maxUploadBytes,
    uploadLimit: `${maxUploadBytes / (1024 * 1024)} MiB`,
    configurationError: status === null ? 'Checking whether Deepgram is available.' : 'Deepgram is unavailable. Reload the page to check again.',
  };
}
function isTranscribing(rec) { return Boolean(state.processing[rec.id]) || activeStages.has(rec.status); }
function elapsedLabel(startedAt) { return startedAt ? formatTime(Math.max(0,(Date.now()-startedAt)/1000)) + ' elapsed' : ''; }
function progressLabel(current) {
  const parts=[];
  if (Number.isFinite(current.percent)) parts.push(Math.round(current.percent)+'%');
  if (Number.isFinite(current.etaSeconds) && current.etaSeconds > 0) parts.push('About '+formatTime(current.etaSeconds)+' left');
  else if (current.startedAt) parts.push(elapsedLabel(current.startedAt));
  return parts.join(' · ');
}

function recordById(id) { return state.recordings.find(r => r.id === id); }
function speakerById(rec, id) { return rec.speakers.find(s => s.id === id) || {id, name:'Unknown speaker', confirmed:false}; }
function displayName(speaker) { return speaker.name || speaker.label || 'Unknown speaker'; }
function hasUnassignedSegments(rec) { return rec.segments.some(s=>s.speakerId === 'unassigned'); }
function isAsrDraft(rec) { return Boolean(rec.asrDraft || ['draft','uncorrected-asr'].includes(rec.reviewStatus) || (rec.source === 'user-recording' && rec.reviewStatus !== 'reviewed')); }
// Speaker colors follow the order in which voices first appear, so the same
// recording always reads the same way. Hues are tuned for text on the paper surface.
const SPEAKER_COLORS = ['#0b6875', '#a2521d', '#5a4a9c', '#2f6e44', '#a13a62', '#35609a'];
function speakerColors(rec) {
  const colors = new Map();
  rec.segments.forEach(segment => {
    if (segment.speakerId !== 'unassigned' && !colors.has(segment.speakerId)) colors.set(segment.speakerId, SPEAKER_COLORS[colors.size % SPEAKER_COLORS.length]);
  });
  return colors;
}
function speakerStats(rec) {
  const totals = new Map();
  let all = 0;
  rec.segments.forEach(segment => {
    const seconds = Number.isFinite(segment.start) && Number.isFinite(segment.end) ? Math.max(0, segment.end - segment.start) : 0;
    totals.set(segment.speakerId, (totals.get(segment.speakerId) || 0) + seconds);
    all += seconds;
  });
  return [...totals].map(([id, seconds]) => ({id, share:all ? Math.round(seconds / all * 100) : null}));
}
function paragraphById(rec, id) { return groupTranscriptParagraphs(rec.segments).find(paragraph => String(paragraph.id) === String(id)); }
function transcriptText(rec) {
  let previous = null;
  return groupTranscriptParagraphs(rec.segments).map(paragraph => {
    const heading = paragraph.speakerId === previous ? '' : displayName(speakerById(rec, paragraph.speakerId)) + (Number.isFinite(paragraph.start) ? '  ' + formatTime(paragraph.start) : '') + '\n';
    previous = paragraph.speakerId;
    return heading + paragraph.text;
  }).join('\n\n');
}
async function copyText(text, message) {
  try { await navigator.clipboard.writeText(text); notify(message); }
  catch { notify('Copying is not available in this browser.'); }
}
function route() {
  const match = location.hash.match(/^#\/recording\/(.+)$/);
  const projectMatch = location.hash.match(/^#\/project\/(.+)$/);
  let id = null, projectId = null;
  try { id = match ? decodeURIComponent(match[1]) : null; projectId = projectMatch ? decodeURIComponent(projectMatch[1]) : null; } catch {}
  if (id && recordById(id)) return {view:'detail', id};
  if (projectId && projectById(projectId)) return {view:'project', projectId};
  if (location.hash === '#/library' || match || projectMatch) return {view:'library'};
  return {view:'upload'};
}
// Projects group recordings that belong to one context (ten playtests, four interviews)
// so they can be read, filed and handed to an AI assistant together.
function projectById(id) { return state.projects.find(project => project.id === id); }
function projectRecordings(id) {
  return state.recordings.filter(rec => (rec.projectId || '') === (id || '') && (!rec.projectId || projectById(rec.projectId)))
    .slice().sort((a, b) => new Date(a.uploadedAt) - new Date(b.uploadedAt));
}
function recordingProject(rec) { return rec.projectId ? projectById(rec.projectId) : null; }
function durationLabel(seconds) {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? Math.floor(minutes / 60) + ' h ' + (minutes % 60) + ' min' : Math.max(minutes, seconds ? 1 : 0) + ' min';
}
function projectSummary(id) {
  const recs = projectRecordings(id);
  return recs.length + ' recording' + (recs.length === 1 ? '' : 's') + (recs.length ? ' · ' + durationLabel(recs.reduce((sum, rec) => sum + (rec.duration || 0), 0)) : '');
}
function estimateTokens(text) {
  const cjk = (text.match(/[぀-ヿ㐀-鿿]/g) || []).length;
  const words = (text.replace(/[぀-ヿ㐀-鿿]/g, ' ').match(/\S+/g) || []).length;
  return Math.round(cjk * 1.1 + words * 1.35);
}
const DEFAULT_PACK_TASK = 'Read every recording first. Then:\n1. Summarize each recording in three bullet points.\n2. Identify the trends and recurring themes across recordings, and say how many recordings each one appears in.\n3. Point out disagreements, outliers and anything said only once that still seems important.\n4. Quote the most telling moments, citing the recording title and timestamp.';
// One Markdown file an AI assistant can read without guessing: what the file is, how each
// line is shaped, an index, then every recording as "[mm:ss] Speaker: text".
function buildContextPack(name, recs, task) {
  const ready = recs.filter(rec => rec.segments.length);
  const date = value => new Intl.DateTimeFormat('en-CA', {year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date(value));
  const speakersOf = rec => speakerStats(rec).map(({id, share}) => displayName(speakerById(rec, id)) + (share === null ? '' : ' (' + share + '% of speaking time)')).join(', ');
  const cell = value => String(value).replace(/\|/g, '/').replace(/\s+/g, ' ');
  const lines = [
    '# ' + name + ': transcript pack', '',
    'Generated by Duowen on ' + date(Date.now()) + '. ' + ready.length + ' recording' + (ready.length === 1 ? '' : 's') + ', ' + durationLabel(ready.reduce((sum, rec) => sum + (rec.duration || 0), 0)) + ' of audio in total.', '',
    '## How to read this file', '',
    '- Each recording is its own section, headed "Recording N of ' + ready.length + '", in the order the recordings were added.',
    '- Every transcript line has the form `[mm:ss] Speaker: text`. The timestamp is the position in that recording\'s audio.',
    '- Speaker labels are assigned per recording. "Speaker 1" in one recording is not the same person as "Speaker 1" in another unless a real name is used.',
    '- Transcripts were produced automatically and may contain recognition errors, especially in names, numbers and mixed-language speech.',
    '- When you cite something, give the recording title and the timestamp.', '',
  ];
  if (task.trim()) lines.push('## Task', '', task.trim(), '');
  lines.push('## Index', '', '| # | Recording | Added | Length | Speakers |', '|---|---|---|---|---|');
  ready.forEach((rec, index) => lines.push('| ' + (index + 1) + ' | ' + cell(rec.title) + ' | ' + date(rec.uploadedAt) + ' | ' + formatTime(rec.duration) + ' | ' + new Set(rec.segments.map(s => s.speakerId)).size + ' |'));
  ready.forEach((rec, index) => {
    lines.push('', '---', '', '## Recording ' + (index + 1) + ' of ' + ready.length + ': ' + rec.title, '',
      '- Source file: ' + rec.originalFilename, '- Added: ' + date(rec.uploadedAt), '- Length: ' + formatTime(rec.duration), '- Speakers: ' + speakersOf(rec), '');
    groupTranscriptParagraphs(rec.segments).forEach(paragraph => lines.push((Number.isFinite(paragraph.start) ? '[' + formatTime(paragraph.start) + '] ' : '') + displayName(speakerById(rec, paragraph.speakerId)) + ': ' + paragraph.text, ''));
  });
  return lines.join('\n').trimEnd() + '\n';
}
function packSource(dialog) {
  const project = projectById(dialog.projectId);
  const recs = project ? projectRecordings(project.id) : [recordById(dialog.recordingId)].filter(Boolean);
  return {name:project ? project.name : recs[0]?.title || 'Recording', recs, ready:recs.filter(rec => rec.segments.length)};
}
function currentRec() { return recordById(route().id); }
function navigate(id = null) {
  if (route().view === 'library' && id) state.libraryScroll = window.scrollY;
  state.transcriptSearch = '';
  state.detailTab = 'transcript';
  state.answer = null;
  const nextHash = id ? '#/recording/' + encodeURIComponent(id) : '#/library';
  if (location.hash === nextHash) {
    render();
    window.scrollTo({top:id ? 0 : state.libraryScroll, behavior:'instant'});
  } else location.hash = nextHash;
}
function goToPage(view) {
  if (route().view === 'library') state.libraryScroll = window.scrollY;
  const hash = view === 'library' ? '#/library' : '#/upload';
  state.transcriptSearch = ''; state.answer = null;
  if (location.hash === hash) {
    render(); window.scrollTo({top:view === 'library' ? state.libraryScroll : 0, behavior:'instant'});
  } else location.hash = hash;
}
function notify(message, action = null) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role','status'); document.body.append(el); }
  el.innerHTML = `<span>${esc(message)}</span>${action ? '<button type="button" data-action="undo">Undo</button>' : ''}`;
  el.classList.add('visible');
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => el.classList.remove('visible'), action ? 7000 : 3800);
}
function persist() {
  try {
    const recordings = state.recordings.map(r => {
      const copy = clone(r);
      if (r.source === 'local-upload') {
        copy.audioUrl = null;
        copy.needsAudio = true;
        if (isTranscribing(r) && !r.transcription?.job?.accessToken) {
          copy.status='interrupted';
          const error=r.transcription?.engine==='deepgram'?'The page closed before receiving a transcript. Retry with the original file.':'Transcription stopped when this page was closed or refreshed.';
          copy.transcription={...copy.transcription,status:'interrupted',stage:'interrupted',error};
        }
      } else delete copy.audioUrl;
      if(copy.transcription)delete copy.transcription.cancelRequestInFlight;
      delete copy.processing;
      return copy;
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify({recordings, knownSpeakers:state.knownSpeakers, projects:state.projects, seedSignature:state.seedSignature}));
  } catch { /* Browser storage is optional for this local demo. */ }
}
function normalize(rec, index) {
  const normalized = {
    ...rec, id:rec.id || 'sample-' + index,
    originalFilename:rec.originalFilename || rec.filename || 'recording.wav',
    batchId:rec.batchId || rec.batch || 'sample-batch',
    uploadedAt:rec.uploadedAt || '2026-11-05T01:00:00-05:00',
    audioUrl:rec.audioUrl || null,
    duration:Number(rec.duration) || 0, source:rec.source || 'sample', status:rec.status || 'ready',
    speakers:(rec.speakers || []).map((s, i) => ({...s, id:s.id || 'speaker-' + i, name:s.name || s.label || 'Speaker ' + (i + 1)})),
    segments:(rec.segments || []).map((s, i) => ({...s, id:s.id || 'segment-' + i, speakerId:s.speakerId || s.speaker || 'speaker-0'})),
    notes:rec.notes || {summary:[], actions:[], decisions:[]}, qa:rec.qa || []
  };
  if (normalized.source === 'local-upload' && !normalized.segments.length && !normalized.audioUrl) {
    normalized.needsAudio=true;
    if (!normalized.transcription?.job?.accessToken && !['error','cancelled','interrupted'].includes(normalized.status)) normalized.status='interrupted';
    normalized.transcription={...normalized.transcription,status:normalized.status};
  }
  normalized.segments.forEach(segment => {
    if (!normalized.speakers.some(s=>s.id === segment.speakerId)) normalized.speakers.push({id:segment.speakerId,name:segment.speakerId === 'unassigned' ? 'Unknown speaker' : 'Speaker ' + (normalized.speakers.length + 1),confirmed:false});
  });
  return normalized;
}
async function init() {
  root.innerHTML = '<main class="shell loading-screen" aria-label="Loading demo"><span class="loading-ring"></span><span>Opening Duowen…</span></main>';
  if (getTranscriptionMode().engine === 'deepgram') {
    checkDeepgramAvailability().then(status => {
      state.deepgramStatus = status;
      if (!state.loading && route().view === 'upload') render();
    });
  }
  try {
    // A visitor's library starts empty: only recordings they add appear in it.
    // The standalone export can still embed recordings through __DEMO_RECORDINGS__.
    const payload = window.__DEMO_RECORDINGS__ || [];
    const samples = Array.isArray(payload) ? payload : payload.recordings || [];
    state.seed = samples.map(normalize);
    state.seedSignature = JSON.stringify(state.seed.map(r => [r.id,r.source,r.originalFilename,r.duration,r.segments.map(s=>[s.id,s.start,s.end,s.text])]));
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch {}
    if (Array.isArray(saved?.recordings) && saved.seedSignature === state.seedSignature) {
      state.recordings = saved.recordings.map((rec, index) => {
        const seed = state.seed.find(sample => sample.id === rec.id);
        return normalize({...rec, audioUrl:rec.source !== 'local-upload' ? seed?.audioUrl || null : null},index);
      });
    } else {
      const local = (saved?.recordings || []).filter(r=>r.source === 'local-upload').map((r,i)=>normalize({...r,audioUrl:null,needsAudio:true},i));
      state.recordings = [...local,...clone(state.seed)];
    }
    state.knownSpeakers = saved?.knownSpeakers || [];
    state.projects = Array.isArray(saved?.projects) ? saved.projects : [];
    state.loading = false;
    if (!location.hash || location.hash === '#/') history.replaceState(null,'',location.pathname + location.search + '#/upload');
    persist();
    render();
    restoreStoredAudio();
    state.recordings.filter(rec=>rec.source==='local-upload' && !rec.segments.length && rec.transcription?.job?.accessToken && !['error','cancelled'].includes(rec.status)).forEach(rec=>queueTranscription(rec,null,{resumeJob:rec.transcription.job}));
  } catch (error) {
    state.loading = false;
    render();
    notify('Your saved library could not be opened. You can still add a recording.');
  }
}
// Uploaded audio is kept in this browser (IndexedDB) so playback still works after a
// refresh. Storage is best effort: private windows or a full disk fall back to reconnecting.
function audioFiles(mode) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('duowen-audio', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('files');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('files', mode);
      const done = new Promise((finish, fail) => { tx.oncomplete = () => { db.close(); finish(); }; tx.onerror = tx.onabort = () => { db.close(); fail(tx.error); }; });
      resolve({store:tx.objectStore('files'), done});
    };
  });
}
async function storeAudio(id, file) {
  try { const {store, done} = await audioFiles('readwrite'); store.put(file, id); await done; } catch { /* Playback then needs the file again after a refresh. */ }
}
async function clearStoredAudio() {
  try { const {store, done} = await audioFiles('readwrite'); store.clear(); await done; } catch {}
}
async function restoreStoredAudio() {
  try {
    const {store, done} = await audioFiles('readwrite');
    const request = (operation) => new Promise(resolve => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => resolve(null); });
    const keys = await request(store.getAllKeys()) || [];
    const wanted = state.recordings.filter(rec => rec.source === 'local-upload' && !rec.audioUrl);
    const files = await Promise.all(wanted.map(rec => keys.includes(rec.id) ? request(store.get(rec.id)) : null));
    keys.filter(key => !recordById(key)).forEach(key => store.delete(key));
    await done;
    let restored = false;
    wanted.forEach((rec, index) => {
      const file = files[index];
      if (!file || recordById(rec.id) !== rec || rec.audioUrl) return;
      rec.audioUrl = URL.createObjectURL(file); rec.needsAudio = false; localFiles.set(rec.id, file); restored = true;
    });
    if (restored && !$('.transcript-paragraph.is-editing')) render();
  } catch {}
}
function excerptInfo(rec) {
  const metadata=rec.excerpt || rec.clip || {};
  const start=Number(metadata.start ?? metadata.startSeconds ?? rec.provenance?.clipStartSeconds ?? 0);
  const end=Number(metadata.end ?? metadata.endSeconds ?? rec.provenance?.clipEndSeconds);
  const duration=Number(metadata.duration ?? metadata.durationSeconds ?? (Number.isFinite(end) ? end-start : rec.duration));
  const original=Number(rec.sourceDuration ?? rec.originalDurationSeconds ?? rec.provenance?.originalDurationSeconds);
  return rec.source === 'user-recording' && Number.isFinite(duration) && duration>0 && Number.isFinite(original) && original>duration ? {start,end:Number.isFinite(end)?end:start+duration,duration,original} : null;
}
function sourceLabel(rec) { const excerpt=excerptInfo(rec);return excerpt ? Math.round(excerpt.duration)+'s excerpt' : rec.sourceLabel || (rec.source === 'local-upload' ? 'Local' : 'Sample'); }
function fileSourceLabel(rec) { if(rec.source==='local-upload')return ''; const label=sourceLabel(rec);return isAsrDraft(rec) && !label.toLowerCase().includes('draft') ? label+' · ASR draft' : label; }
function status(rec) {
  if (state.processing[rec.id]) {
    const current=state.processing[rec.id];
    if(['cancelling','cancellation-unconfirmed'].includes(current.key))return {...current,detail:current.key==='cancelling'?'Waiting for service confirmation':'Retry cancellation or check status'};
    return {...current,detail:progressLabel(current) || current.detail};
  }
  if (rec.transcription?.job?.accessToken && rec.transcription.cancelRequestedAt) return {key:rec.transcription.cancellationError?'cancellation-unconfirmed':'cancelling',label:rec.transcription.cancellationError?'Cancellation not confirmed':'Cancelling',detail:rec.transcription.cancellationError?'Retry cancellation or check status':'Waiting for WhisperX to stop'};
  if (rec.status === 'error') return {key:'error',label:'Transcription failed',detail:'Open to retry'};
  if (rec.transcription?.stoppedWaiting) return {key:'cancelled',label:'Stopped waiting',detail:'Open to retry'};
  if (rec.status === 'cancelled') return {key:'cancelled',label:'Transcription cancelled',detail:'Open to resume'};
  if (rec.status === 'interrupted' || !rec.segments.length) return {key:'interrupted',label:'Transcription paused',detail:'Choose the audio to resume'};
  if (hasUnassignedSegments(rec)) return {key:'partial',label:'Transcript ready',detail:'Speakers unassigned'};
  return {key:'ready',label:'Transcript ready',detail:''};
}
function statusMarkup(rec) {
  const current=status(rec);
  return `<span class="record-status state-${esc(current.key)} ${current.key==='ready'?'ready-label':''}" data-recording-status="${esc(rec.id)}" data-status-key="${esc(current.key)}"><span class="status-top">${icon(icons[current.key] || 'info')}<span>${esc(current.label)}</span></span>${current.detail ? '<span class="status-detail">'+esc(current.detail)+'</span>':''}</span>`;
}
function toolbar(mode = 'library') {
  const link = (view, label, name) => `<a class="nav-link ${mode === view ? 'active' : ''}" href="#/${view}" ${mode === view ? 'aria-current="page"' : ''}>${icon(name)}<span>${label}</span></a>`;
  const active = route();
  const openProject = active.view === 'project' ? active.projectId : active.view === 'detail' ? recordById(active.id)?.projectId : null;
  // A sidebar on wide screens, a top bar on narrow ones; the markup is the same.
  // Home already is the place to add a recording, so the shortcut button appears everywhere else.
  return `<header class="toolbar">
    <div class="toolbar-left"><a class="brand" href="#/upload" aria-label="Duowen home">${icon('waveform')}<span>Duowen</span></a>
      <nav class="top-nav" aria-label="Primary">${link('upload','Home','house')}${link('library','Library','stack')}</nav>
      ${mode === 'upload' ? '' : `<button type="button" class="button primary new-button" data-action="choose-upload" aria-label="New transcript">${icon('plus')}<span>New transcript</span></button>`}</div>
    <nav class="side-recents" aria-label="Projects"><span class="side-label">Projects</span>${state.projects.map(project => `<a class="side-link ${project.id === openProject ? 'active' : ''}" href="#/project/${encodeURIComponent(project.id)}" ${project.id === openProject && active.view === 'project' ? 'aria-current="page"' : ''}>${icon('folder')}<span>${esc(project.name)}</span><span class="side-count">${projectRecordings(project.id).length}</span></a>`).join('')}<button type="button" class="side-link side-new" data-action="new-project">${icon('plus')}<span>New project</span></button></nav>
    <div class="toolbar-actions"><button type="button" class="nav-link" data-action="info" aria-label="About Duowen">${icon('info')}<span>About</span></button></div>
  </header>`;
}
function player(rec) {
  const active = state.audioId === rec.id;
  const time = active ? audio.currentTime || 0 : 0;
  const id = esc(rec.id);
  const play = button(active && state.playing ? 'pause' : 'play', active && state.playing ? 'Pause audio' : 'Play audio','play','data-id="' + id + '"','play-control');
  const track = `<div class="player-track"><input type="range" min="0" max="${Math.max(rec.duration,1)}" step="0.01" value="${time}" class="seek" aria-label="Seek audio" data-seek="${id}" style="--progress:${rec.duration ? time / rec.duration * 100 : 0}%"></div>`;
  const clock = `<span class="player-time" data-time="${id}">${formatTime(time)} / ${formatTime(rec.duration)}</span>`;
  const speed = `<label class="speed-select"><span class="sr-only">Playback speed</span><select data-speed="${id}" aria-label="Playback speed">${[0.75,1,1.25,1.5,2].map(n => `<option value="${n}" ${state.rate === n ? 'selected' : ''}>${n}×</option>`).join('')}</select>${icon('caret-down')}</label>`;
  // The detail player is docked to the viewport so a 40-minute transcript never scrolls it away.
  return `<div class="player-dock"><button type="button" class="follow-pill" data-action="follow" data-id="${id}" hidden>${icon('arrow-down')}Back to current line</button>
    <div class="player dock-player" data-player="${id}" role="group" aria-label="Audio player">
      ${button('arrow-counter-clockwise','Back 10 seconds','skip','data-id="' + id + '" data-delta="-10"','skip-control')}${play}${button('arrow-clockwise','Forward 10 seconds','skip','data-id="' + id + '" data-delta="10"','skip-control')}
      ${track}${clock}${speed}
    </div></div>`;
}
function recordingModule(rec) {
  const snippet = rec.segments.slice(0, 3).map(s => s.text).join(' ').slice(0, 220);
  const speakers = new Set(rec.segments.map(s => s.speakerId).filter(id => id !== 'unassigned')).size;
  return `<article class="recording-module" data-recording-card="${esc(rec.id)}" aria-label="${esc(rec.title)} recording">
    <div class="recording-header"><a href="#/recording/${encodeURIComponent(rec.id)}" class="recording-main" aria-label="Open ${esc(rec.title)}">
      <div class="record-identity"><h2>${esc(rec.title)}</h2>${snippet ? `<p class="record-snippet">${esc(snippet)}</p>` : ''}<div class="file-meta">${recordingProject(rec) && route().view !== 'project' && state.libraryView !== 'project' ? icon('folder') + esc(recordingProject(rec).name) + '<span aria-hidden="true"> · </span>' : ''}${speakers > 1 ? speakers + ' speakers<span aria-hidden="true"> · </span>' : ''}${esc(rec.originalFilename)}${fileSourceLabel(rec) ? `<span aria-hidden="true"> · </span><span>${esc(fileSourceLabel(rec))}</span>` : ''}</div></div>
      <span class="record-duration">${formatTime(rec.duration)}</span>${statusMarkup(rec)}</a>
      ${button('dots-three','Recording actions','recording-menu','data-id="' + esc(rec.id) + '"','quiet')}
    </div>
  </article>`;
}
function libraryList() {
  const active = route();
  const inProject = active.view === 'project';
  const query = inProject ? '' : state.search.toLowerCase().trim();
  const pool = inProject ? projectRecordings(active.projectId) : state.recordings;
  const filtered = pool.filter(r => [r.title, r.originalFilename, recordingProject(r)?.name || '', ...r.speakers.map(displayName)].some(v => v.toLowerCase().includes(query)));
  if (inProject) return filtered.length ? '<div class="batch-list">' + filtered.map(recordingModule).join('') + '</div>'
    : `<div class="empty-state">${icon('folder-open')}<h2>This project is empty</h2><p>Drop recordings anywhere on this page and they are filed here. You can also move existing recordings in from the Library.</p><button class="button primary" data-action="choose-upload">${icon('plus')}Add recordings</button></div>`;
  if (!filtered.length) return `<div class="empty-state">${icon(state.search ? 'magnifying-glass' : 'waveform')}<h2>${state.search ? 'No recordings found' : 'Your first recording starts here'}</h2><p>${state.search ? 'Try another file name, speaker or project.' : 'Add audio or video and its transcript will appear here.'}</p>${state.search ? '<button class="text-button" data-action="clear-search">Clear search</button>' : '<button class="button primary" data-action="upload">'+icon('plus')+'New transcript</button>'}</div>`;
  const byProject = state.libraryView === 'project';
  const groups = new Map();
  if (byProject) state.projects.forEach(project => groups.set('project:' + project.id, []));
  filtered.forEach(r => { const key = byProject ? 'project:' + (recordingProject(r)?.id || '') : r.batchId; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(r); });
  return [...groups.entries()].filter(([, recs]) => recs.length || !query).map(([id, recs]) => {
    const project = byProject ? projectById(id.slice(8)) : null;
    const collapsed = state.collapsedBatches.has(id);
    const heading = byProject
      ? `<span class="batch-day">${icon(project ? 'folder' : 'tray')}${esc(project ? project.name : 'No project')}</span><span class="batch-time">${recs.length} recording${recs.length === 1 ? '' : 's'}</span>`
      : `<span class="batch-day">${esc(dayLabel(recs[0].uploadedAt))}</span><span class="batch-time">${esc(timeLabel(recs[0].uploadedAt))}</span>`;
    return `<section class="batch">
      <div class="batch-head"><button type="button" class="batch-header" data-action="batch" data-batch-id="${esc(id)}" aria-expanded="${!collapsed}">${heading}<span class="batch-caret">${icon(collapsed ? 'caret-right' : 'caret-down')}</span></button>${project ? `<a class="text-button" href="#/project/${encodeURIComponent(project.id)}">Open${icon('arrow-right')}</a>` : ''}</div>
      ${collapsed ? '' : recs.length ? '<div class="batch-list">' + recs.map(recordingModule).join('') + '</div>' : '<p class="batch-empty">No recordings yet.</p>'}
    </section>`;
  }).join('');
}
function renderLibrary() {
  const view = (id, label, name) => `<button type="button" class="segment ${state.libraryView === id ? 'active' : ''}" data-action="library-view" data-view="${id}" aria-pressed="${state.libraryView === id}">${icon(name)}${label}</button>`;
  return `<main class="shell library-shell">${toolbar()}<div class="library-context"><div><h1>Library</h1><span>${state.recordings.length} recording${state.recordings.length === 1 ? '' : 's'}</span></div><div class="library-tools"><div class="segmented" role="group" aria-label="Group recordings">${view('date','By date','calendar-blank')}${view('project','By project','folder')}</div><div class="search-field">${icon('magnifying-glass')}<input id="library-search" type="search" autocomplete="off" placeholder="Search recordings" value="${esc(state.search)}" aria-label="Search recordings"></div></div></div><div id="recording-list">${libraryList()}</div><footer class="library-footer"><button type="button" class="quiet-link" data-action="info">About Duowen and your data</button></footer></main>`;
}
function renderProject(project) {
  const id = esc(project.id);
  const ready = projectRecordings(project.id).filter(rec => rec.segments.length).length;
  return `<main class="shell library-shell project-shell">${toolbar('project')}
    <div class="library-context project-context"><div class="project-title"><a class="crumb" href="#/library">${icon('arrow-left')}Library</a><h1><button class="editable-title" data-action="rename-project" data-project-id="${id}" aria-label="Rename project: ${esc(project.name)}">${icon('folder')}${esc(project.name)}${icon('pencil-simple')}</button></h1><span>${esc(projectSummary(project.id))}</span></div>
      <div class="library-tools"><button type="button" class="button secondary" data-action="choose-upload">${icon('plus')}Add recordings</button><button type="button" class="button primary" data-action="ai-pack" data-project-id="${id}" ${ready ? '' : 'disabled'}>${icon('sparkle')}Send to AI</button>${button('dots-three','Project actions','project-menu','data-project-id="' + id + '"','quiet')}</div></div>
    <div id="recording-list">${libraryList()}</div>
  </main>`;
}
function projectsMarkup() {
  const cards = state.projects.map(project => `<a class="project-card" href="#/project/${encodeURIComponent(project.id)}">${icon('folder')}<strong>${esc(project.name)}</strong><span>${esc(projectSummary(project.id))}</span></a>`).join('');
  return `<section class="recent projects" aria-labelledby="projects-title">
    <div class="recent-head"><h2 id="projects-title">Projects</h2><button type="button" class="text-button" data-action="new-project">${icon('plus')}New project</button></div>
    ${state.projects.length ? `<div class="project-grid">${cards}</div>` : `<button type="button" class="project-empty" data-action="new-project">${icon('folder-plus')}<span><strong>Group recordings that belong together</strong><span>Put ten playtest sessions or four interviews in one project, then hand all of their transcripts to Claude or ChatGPT as a single file.</span></span></button>`}
  </section>`;
}
function recentMarkup() {
  const recent = state.recordings.slice(0, 3);
  if (!recent.length) return '';
  return `<section class="recent" aria-labelledby="recent-title">
    <div class="recent-head"><h2 id="recent-title">Recent</h2><a class="text-button" href="#/library">All recordings${icon('arrow-right')}</a></div>
    <div class="recent-list">${recent.map(rec => {
      const snippet = rec.segments.length ? rec.segments.slice(0, 3).map(s => s.text).join(' ') : '';
      return `<a class="recent-row" href="#/recording/${encodeURIComponent(rec.id)}">
        <span class="recent-time">${esc(dayLabel(rec.uploadedAt))}</span>
        <span class="recent-body"><strong>${esc(rec.title)}</strong>${snippet ? `<span class="recent-snippet">${esc(snippet.slice(0, 160))}</span>` : ''}</span>
        ${rec.segments.length && !state.processing[rec.id] ? `<span class="recent-duration">${formatTime(rec.duration)}</span>` : statusMarkup(rec)}
      </a>`;
    }).join('')}</div>
  </section>`;
}
function providerDetails(mode) {
  return mode.engine !== 'deepgram' ? '' : `<details class="transcription-providers">
    <summary>Transcription providers and pricing</summary>
    <div class="provider-options">
      <div class="provider-option ${mode.configured?'is-selected':''}"><div><strong>Deepgram Nova-3</strong><span class="provider-badge">${mode.configured?'Active':mode.checking?'Checking':'Unavailable'}</span></div><p>Estimated US$0.0072 per audio minute for prerecorded multilingual transcription with speaker labels. Deepgram offers a one-time US$200 trial credit.</p></div>
      <div class="provider-option"><div><strong>Hugging Face + WhisperX</strong><span class="provider-badge">Planned</span></div><p>Compute estimate of US$0.03 per hour, or US$21.90 for 730 hours. Available once configured.</p></div>
    </div>
    <p>Provider billing may vary. Visitors are not charged.</p>
  </details>`;
}
function renderUpload() {
  const mode = transcriptionMode();
  const blocked = mode.engine==='deepgram' && !mode.configured;
  return `<main class="shell upload-shell">${toolbar('upload')}
    <section class="upload-entry" aria-labelledby="upload-title">
      <div class="entry-heading"><h1 id="upload-title">Turn a recording into a transcript you can read</h1><p>Drop in audio or video. Duowen separates the speakers, keeps every timestamp, and starts right away.</p></div>
      ${mode.configured===false ? '<div class="service-notice" role="status">'+icon('plug')+'<span><strong>'+(mode.checking ? 'Checking transcription service' : 'Transcription is unavailable')+'</strong><br>'+esc(mode.configurationError)+'</span></div>' : ''}
      <div class="upload-dropzone ${blocked?'is-disabled':''}" id="upload-dropzone">
        <div class="upload-symbol">${icon('waveform')}</div>
        <h2><span class="for-pointer">Drop a recording anywhere</span><span class="for-touch">Add a recording</span></h2>
        <button type="button" class="button primary upload-choice" data-action="choose-upload" ${blocked?'disabled':''}>${icon('plus')}Choose a file</button>
        <p class="upload-formats">MP3, M4A, WAV, MP4, MOV and more${mode.uploadLimit && mode.configured ? ` · up to ${mode.uploadLimit} each` : ''} · several files at once is fine</p>
      </div>
      <p class="upload-privacy">${icon('lock-key')}${mode.configured ? `Files are sent to ${esc(mode.label)} for transcription. Transcripts and edits stay in this browser.` : 'Audio and video uploads are unavailable.'}</p>
      ${projectsMarkup()}
      ${recentMarkup()}
    </section>
  </main>`;
}

function missingTranscript(rec, compact = false) {
  if(rec.transcription?.job?.accessToken && rec.transcription.cancelRequestedAt)return processingMarkup(rec);
  const current=status(rec), needsFile=!rec.transcription?.job?.accessToken && (rec.needsAudio || !localFiles.has(rec.id));
  const failed=rec.status==='error';
  const deepgram=rec.transcription?.engine==='deepgram';
  const heading=failed ? 'Transcription could not finish' : rec.transcription?.stoppedWaiting ? 'Stopped waiting for Deepgram' : rec.status==='cancelled' ? 'Transcription cancelled' : deepgram ? 'Retry transcription' : 'Resume transcription';
  const message=failed ? rec.transcription?.error || 'Please retry this recording or choose another audio format.' : deepgram ? 'Deepgram results are only available while the request is open. Retry with the original file.' : needsFile ? 'Choose the original audio once to continue. A transcript file is not needed.' : 'Your audio is still available. Resume when you are ready.';
  return `<div class="missing-transcript ${compact?'is-compact':''}">${icon(failed?'warning-circle':needsFile?'link':'arrow-clockwise')}<div><h3>${heading}</h3><p>${esc(message)}</p><button type="button" class="button ${failed?'primary':'secondary'}" data-action="${needsFile?'reconnect':'retry-transcription'}" data-id="${esc(rec.id)}">${icon(needsFile?'file-audio':'arrow-clockwise')}${needsFile?'Choose original audio':'Retry transcription'}</button></div></div>`;
}
function processingVisual(rec) {
  const current=state.processing[rec.id] || status(rec);
  if(['cancelling','cancellation-unconfirmed'].includes(current.key)) return `<div class="processing-heading">${current.key==='cancelling'?'<span class="loading-ring" aria-hidden="true"></span>':icon('warning-circle')}<h3 aria-live="polite">${esc(current.label)}</h3></div><p class="processing-description">${esc(rec.transcription.cancellationError || current.detail || 'Waiting for the service to confirm that processing has stopped.')}</p><p class="fine-print">The cloud job may still be running until cancellation is confirmed.</p>`;
  const known=Number.isFinite(current.percent), percent=known?Math.max(0,Math.min(100,current.percent)):null;
  return `<div class="processing-heading"><span class="loading-ring" aria-hidden="true"></span><h3 aria-live="polite">${esc(current.label)}</h3></div><p class="processing-description">${esc(current.detail || 'Your transcript will appear here as soon as it is ready.')}</p><div class="job-progress ${known?'':'is-indeterminate'}" role="progressbar" aria-label="${esc(current.label)}" ${known?'aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+Math.round(percent)+'"':''}><span style="${known?'width:'+percent+'%':''}"></span></div><div class="job-progress-meta"><span>${esc(progressLabel(current) || (current.key==='queued'?'Waiting for a processing slot':'Processing your recording'))}</span></div>`;
}
function processingMarkup(rec) {
  return `<div class="processing-panel" data-processing-view="${esc(rec.id)}"><div class="processing-visual">${processingVisual(rec)}</div><div class="processing-actions">${cancellationActions(rec)}</div><p class="fine-print" data-job-retention>${cancellationRetention(rec)}</p>
    <div class="transcript-skeleton" aria-hidden="true">${[[92,64],[78],[96,88,41]].map(lines=>'<div class="skeleton-turn"><span class="skeleton-name"></span>'+lines.map(width=>'<span class="skeleton-line" style="width:'+width+'%"></span>').join('')+'</div>').join('')}</div></div>`;
}
function cancellationActions(rec) {
  const waiting=Boolean(rec.transcription?.cancelRequestedAt && rec.transcription?.job?.accessToken),requesting=Boolean(rec.transcription?.cancelRequestInFlight);
  const stopWaiting=rec.transcription?.engine==='deepgram' && ['uploading','transcribing'].includes(rec.status);
  return `<button type="button" class="quiet-link" data-action="cancel-transcription" data-id="${esc(rec.id)}" ${requesting?'disabled':''}>${icon(requesting?'circle-notch':'x')}${requesting?'Requesting cancellation':waiting?'Retry cancellation':stopWaiting?'Stop waiting':'Cancel transcription'}</button>${waiting?`<button type="button" class="quiet-link" data-action="retry-transcription" data-id="${esc(rec.id)}">${icon('arrow-clockwise')}Check status</button>`:''}`;
}
function cancellationRetention(rec) {
  if (rec.transcription?.engine==='deepgram') return 'Keep this page open until the transcript is ready. If you stop waiting, Deepgram may still finish the request.';
  return rec.transcription?.job?.accessToken?'You can switch views or refresh. This cloud job will reconnect automatically.':'You can leave this view. Keep this page open until the audio finishes uploading.';
}
function hasNotes(rec) { const notes = rec.notes || {}; return Boolean(notes.summary?.length || notes.actions?.length || notes.decisions?.length); }
function notesMarkup(rec) {
  const notes = rec.notes || {};
  const item = entry => typeof entry === 'string' ? {text:entry} : entry;
  const cite = entry => entry.segmentId ? citationButton(rec, entry.segmentId) : '';
  if (!rec.segments.length) return '<div class="panel-empty">' + icon('note-pencil') + '<p>Your transcript will appear here when processing finishes.</p><p class="fine-print">No transcript upload is needed.</p></div>';
  if (!notes.summary?.length && !notes.actions?.length && !notes.decisions?.length) return '<div class="panel-empty">' + icon('note-pencil') + '<p>This transcript has no generated notes yet.</p><p class="fine-print">Prepared notes are available for the bundled recordings.</p></div>';
  return `<div class="notes-content">${rec.notesStale ? '<div class="notice">' + icon('info') + '<span>The transcript changed. These notes may need updating.</span></div>' : ''}
    <div class="panel-kicker">Prepared notes</div>
    ${notes.summary?.length ? '<section class="note-section"><h3>Summary</h3><ul class="summary-list">' + notes.summary.map(e => { const o=item(e); return '<li>' + esc(o.text) + cite(o) + '</li>'; }).join('') + '</ul></section>' : ''}
    ${notes.decisions?.length ? '<section class="note-section"><h3>Decisions</h3>' + notes.decisions.map(e => { const o=item(e);return '<div class="decision-item">' + icon('check-circle') + '<p>' + esc(o.text) + cite(o) + '</p></div>'; }).join('') + '</section>' : ''}
    ${notes.actions?.length ? '<section class="note-section"><h3>Next steps</h3>' + notes.actions.map((e,i) => { const o=item(e); return '<label class="action-item"><input type="checkbox" data-note-action="' + i + '" data-id="' + esc(rec.id) + '" ' + (o.done?'checked':'') + '><span>' + esc(o.text) + (o.owner ? '<small>' + esc(o.owner) + '</small>' : '') + cite(o) + '</span></label>'; }).join('') + '</section>' : ''}
  </div>`;
}
function citationButton(rec, segmentId) {
  const segment = rec.segments.find(s => s.id === segmentId);
  return segment ? `<button type="button" class="citation" data-action="cite" data-id="${esc(rec.id)}" data-segment-id="${esc(segmentId)}" aria-label="View source at ${formatTime(segment.start)}">${formatTime(segment.start)}</button>` : '';
}
function qaMarkup(rec) {
  if (!rec.segments.length) return '<div class="panel-empty">'+icon('chat-circle-text')+'<p>Questions become available after transcription.</p></div>';
  const questions = rec.notesStale ? [] : rec.qa || [];
  const answer = state.answer;
  const prepared = questions.length > 0;
  return `<div class="ask-content">${rec.notesStale ? '<div class="notice">' + icon('info') + '<span>The transcript changed. Prepared answers are hidden; search now uses your current text.</span></div>' : ''}
    <p class="ask-intro">${prepared ? 'Ask about this recording' : 'Find where something was said'}</p>
    <form class="ask-form" id="ask-form"><label class="sr-only" for="question-input">${prepared ? 'Ask about this recording' : 'Topic or phrase'}</label><input id="question-input" name="question" placeholder="${prepared ? 'Ask about this recording…' : 'A topic, a name, a phrase…'}" autocomplete="off" required><button type="submit" class="icon-button primary" aria-label="Search" data-tooltip="Search">${icon('arrow-up')}</button></form>
    <p class="fine-print">${prepared ? 'Suggested questions use prepared, source-linked answers. Other questions search this transcript for relevant passages.' : 'Duowen looks for the passages that best match your words and links each one to its moment in the audio. It does not write an answer.'}</p>
    ${prepared ? `<div class="question-suggestions">${questions.map((q,i) => `<button type="button" class="suggestion-button" data-action="ask-suggested" data-id="${esc(rec.id)}" data-question-index="${i}">${esc(q.question)}${icon('arrow-up-right')}</button>`).join('')}</div>` : ''}
    ${answer ? `<div class="qa-answer"><div class="question-label">${esc(answer.question)}</div><p>${esc(answer.answer)}</p><div class="answer-citations">${(answer.citationSegmentIds || []).map(id => citationButton(rec,id)).join('')}</div>${answer.excerpt ? '<span class="panel-kicker">Transcript excerpt</span><blockquote>' + esc(answer.excerpt) + '</blockquote>' : ''}</div>` : ''}</div>`;
}
function highlightText(text, query) {
  if (!query) return esc(text);
  const lower = text.toLowerCase();
  let out = '', from = 0, at;
  while ((at = lower.indexOf(query, from)) >= 0) {
    out += esc(text.slice(from, at)) + '<mark class="hit">' + esc(text.slice(at, at + query.length)) + '</mark>';
    from = at + query.length;
  }
  return out + esc(text.slice(from));
}
function transcriptParagraphMarkup(rec, paragraph, {startsTurn = true, color = '', query = ''} = {}) {
  const speaker = speakerById(rec, paragraph.speakerId);
  const first = paragraph.segments[0];
  const timestamp = formatTime(paragraph.start);
  const record = `data-id="${esc(rec.id)}"`;
  const segment = `data-segment-id="${esc(first.id)}"`;
  const paragraphRef = `data-paragraph-id="${esc(paragraph.id)}"`;
  const passages = paragraph.segments.map((passage, index) => {
    const text = String(passage.text ?? '');
    const separator = index ? transcriptSegmentSeparator(String(paragraph.segments[index - 1].text ?? ''), text) : '';
    return `${separator}<span class="transcript-passage" id="segment-${esc(passage.id)}" data-segment="${esc(passage.id)}" data-recording="${esc(rec.id)}">${highlightText(text.trim(), query)}</span>`;
  }).join('');

  // The speaker is named once per turn; later paragraphs of the same turn keep only their timestamp.
  return `<article class="transcript-paragraph ${startsTurn ? 'starts-turn' : ''}" data-paragraph="${esc(paragraph.id)}" ${color ? `style="--speaker:${color}"` : ''}>
    ${startsTurn ? `<header class="turn-head"><button type="button" class="speaker-label" data-action="speaker" ${record} data-speaker-id="${esc(speaker.id)}" aria-label="Rename ${esc(displayName(speaker))}"><span class="speaker-dot" aria-hidden="true"></span>${esc(displayName(speaker))}</button></header>` : ''}
    <div class="para-row">
      <button type="button" class="timecode" data-action="seek-segment" ${record} ${segment} ${Number.isFinite(paragraph.start) ? `aria-label="Play from ${timestamp}"` : 'disabled title="No timestamp in this imported text"'}>${timestamp}</button>
      <p>${passages}</p>
      <div class="para-actions">${button('copy','Copy paragraph','copy-paragraph',`${record} ${paragraphRef}`,'quiet small')}${button('pencil-simple','Edit text','edit-paragraph',`${record} ${paragraphRef}`,'quiet small')}${button('user-switch','Change speaker for this paragraph','speaker',`${record} ${paragraphRef} data-speaker-id="${esc(speaker.id)}" data-scope="segment"`,'quiet small')}</div>
    </div>
  </article>`;
}
function transcriptParagraphsMarkup(rec) {
  const query = state.transcriptSearch.trim().toLowerCase();
  const colors = speakerColors(rec);
  let previous = null;
  return groupTranscriptParagraphs(rec.segments).map(paragraph => {
    const startsTurn = paragraph.speakerId !== previous;
    previous = paragraph.speakerId;
    return transcriptParagraphMarkup(rec, paragraph, {startsTurn, color:colors.get(paragraph.speakerId), query});
  }).join('');
}
function speakerStrip(rec) {
  if (hasUnassignedSegments(rec)) return `<button type="button" class="speaker-chip is-action" data-action="manage-speakers" data-id="${esc(rec.id)}">${icon('users')}Assign speakers</button>`;
  const colors = speakerColors(rec);
  return speakerStats(rec).map(({id, share}) => {
    const speaker = speakerById(rec, id);
    return `<button type="button" class="speaker-chip" style="--speaker:${colors.get(id)}" data-action="speaker" data-id="${esc(rec.id)}" data-speaker-id="${esc(id)}" aria-label="Rename ${esc(displayName(speaker))}${share === null ? '' : ', ' + share + '% of speaking time'}"><span class="speaker-dot" aria-hidden="true"></span>${esc(displayName(speaker))}${share === null ? '' : `<span class="speaker-share">${share}%</span>`}</button>`;
  }).join('');
}
function transcriptMarkup(rec) {
  if (state.processing[rec.id]) return processingMarkup(rec);
  if (!rec.segments.length) return missingTranscript(rec);
  return `<div class="transcript-tools">
      <div class="speaker-strip" aria-label="Speakers">${speakerStrip(rec)}</div>
      <div class="transcript-search">${icon('magnifying-glass')}<input id="transcript-search" type="search" placeholder="Find in transcript" aria-label="Find in transcript" autocomplete="off" value="${esc(state.transcriptSearch)}"><span class="search-count" id="search-count" role="status"></span>${button('caret-up','Previous match','search-step','data-step="-1"','quiet small search-step')}${button('caret-down','Next match','search-step','data-step="1"','quiet small search-step')}</div>
    </div>
    <div class="transcript-reading" id="transcript-turns">${transcriptParagraphsMarkup(rec)}</div>`;
}
function syncSearch(jump = false) {
  const tools = $('.transcript-search');
  if (!tools) return;
  const hits = $$('#transcript-turns mark.hit');
  const active = Boolean(state.transcriptSearch.trim());
  state.searchIndex = hits.length ? (state.searchIndex % hits.length + hits.length) % hits.length : 0;
  tools.classList.toggle('has-query', active);
  $('#search-count').textContent = !active ? '' : hits.length ? `${state.searchIndex + 1} of ${hits.length}` : 'No matches';
  hits.forEach((hit, index) => hit.classList.toggle('is-current-hit', index === state.searchIndex));
  if (jump && hits.length) hits[state.searchIndex].scrollIntoView({behavior:'instant', block:'center'});
}
function finishParagraphEdit(save) {
  const article = $('.transcript-paragraph.is-editing');
  if (!article) return;
  const rec = currentRec();
  if (!save || !rec) { render(); return; }
  const edits = $$('.transcript-passage', article).map(span => ({segment:rec.segments.find(s => String(s.id) === span.dataset.segment), text:span.textContent.replace(/\s+/g, ' ').trim()}));
  if (edits.some(edit => !edit.text)) { notify('A passage cannot be empty. Type the words, or press Esc to cancel.'); return; }
  const changed = edits.filter(edit => edit.segment && edit.segment.text !== edit.text);
  if (!changed.length) { render(); return; }
  rememberUndo('Text updated', rec.id);
  changed.forEach(edit => { edit.segment.text = edit.text; });
  rec.notesStale = true; state.answer = null; persist(); render(); notify('Transcript text saved.', 'undo');
}
function startParagraphEdit(article) {
  if ($('.transcript-paragraph.is-editing')) finishParagraphEdit(true);
  if (!article?.isConnected) article = article && $(`[data-paragraph="${CSS.escape(article.dataset.paragraph)}"]`);
  if (!article) return;
  article.classList.add('is-editing');
  const spans = $$('.transcript-passage', article);
  spans.forEach(span => { span.textContent = span.textContent; span.contentEditable = 'plaintext-only'; if (span.contentEditable !== 'plaintext-only') span.contentEditable = 'true'; span.spellcheck = true; });
  article.insertAdjacentHTML('beforeend', '<div class="edit-bar"><span>Timestamps stay attached to each sentence.</span><button type="button" class="button secondary" data-action="cancel-edit">Cancel</button><button type="button" class="button primary" data-action="save-edit">Save<kbd>↵</kbd></button></div>');
  const last = spans.at(-1);
  last.focus();
  const range = document.createRange(); range.selectNodeContents(last); range.collapse(false);
  const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
}
function renderDetail(rec) {
  const statusText = status(rec);
  const ready = rec.segments.length > 0;
  const id = esc(rec.id);
  return `<main class="shell detail-shell"><h1 class="sr-only">${esc(rec.title)} transcript</h1>${toolbar('detail')}
    <section class="recording-workspace">
      <header class="detail-heading"><div class="detail-heading-main"><a class="crumb" href="${recordingProject(rec) ? '#/project/' + encodeURIComponent(rec.projectId) : '#/library'}">${icon('arrow-left')}${esc(recordingProject(rec)?.name || 'Library')}</a>
        <div class="detail-title-row"><button class="editable-title" data-action="rename-recording" data-id="${id}" aria-label="Rename recording: ${esc(rec.title)}">${esc(rec.title)}${icon('pencil-simple')}</button></div>
        <div class="detail-meta"><span>${formatTime(rec.duration)}</span><span>${esc(dayLabel(rec.uploadedAt))}, ${esc(timeLabel(rec.uploadedAt))}</span><span>${esc(rec.originalFilename)}</span><span><button type="button" class="meta-link" data-action="move" data-id="${id}">${icon('folder')}${esc(recordingProject(rec)?.name || 'Add to project')}</button></span>${fileSourceLabel(rec) ? `<span class="sample-label">${esc(fileSourceLabel(rec))}</span>` : ''}</div></div>
      <div class="detail-heading-actions">${statusMarkup(rec)}${ready ? `<button type="button" class="button secondary" data-action="copy-transcript" data-id="${id}">${icon('copy')}Copy</button><button type="button" class="button primary" data-action="export" data-id="${id}">${icon('download-simple')}Export</button>` : ''}${button('dots-three','Recording actions','recording-menu','data-id="' + id + '"','quiet')}</div></header>
      <div class="detail-mobile-status state-${esc(statusText.key)}" data-mobile-status="${id}">${icon(icons[statusText.key] || 'info')}<span>${esc(statusText.label)}${statusText.detail?' · '+esc(statusText.detail):''}</span></div>
      <nav class="workspace-tabs" aria-label="Recording workspace"><div class="main-tabs" role="tablist">${[{id:'transcript',icon:'text-align-left',label:'Transcript'},{id:'notes',icon:'note-pencil',label:'Notes'},{id:'ask',icon:'chat-circle-text',label:'Ask'}].filter(t => t.id !== 'notes' || hasNotes(rec)).map(t => `<button id="tab-${t.id}" type="button" role="tab" aria-selected="${state.detailTab === t.id}" aria-controls="workspace-panel" class="workspace-tab ${state.detailTab === t.id ? 'active' : ''}" data-action="tab" data-tab="${t.id}">${icon(t.icon)}${t.label}</button>`).join('')}</div>
      ${ready ? '<span class="shortcut-hint" aria-hidden="true"><kbd>Space</kbd> play <kbd>←</kbd><kbd>→</kbd> 5s <kbd>/</kbd> find</span>' : ''}</nav>
      <div class="workspace-body" id="workspace-panel" role="tabpanel" aria-labelledby="tab-${state.detailTab}">
      ${state.detailTab === 'transcript' ? '<section class="transcript-panel" aria-label="Transcript">' + transcriptMarkup(rec) + '</section>' : '<section class="wide-panel">' + (state.detailTab === 'notes' ? notesMarkup(rec) : qaMarkup(rec)) + '</section>'}
      </div>
    </section>
    <footer class="detail-footer"><span>${rec.source === 'synthetic-demo' ? 'Synthetic speech · authored transcript' : rec.source === 'local-upload' ? rec.needsAudio && rec.segments.length ? 'Transcript saved · reconnect audio for playback' : rec.segments.length ? 'Automatic transcript · review against the audio' : 'Audio selected · automatic transcription' : isAsrDraft(rec) ? 'Unreviewed ASR draft · check the audio when accuracy matters' : 'Sample recording · timestamped transcript'}</span></footer>
    ${ready || rec.audioUrl ? player(rec) : ''}
  </main>`;
}
function render() {
  const pos = window.scrollY;
  const active = route();
  root.innerHTML = active.view === 'detail' ? renderDetail(recordById(active.id)) : active.view === 'project' ? renderProject(projectById(active.projectId)) : active.view === 'library' ? renderLibrary() : renderUpload();
  state.lastView = active.view;
  if (state.dialog && !$('#demo-dialog')) renderDialog();
  updatePlayers();
  syncSearch();
  window.scrollTo({top:pos, behavior:'instant'});
}
function refreshList() {
  const list = $('#recording-list');
  if (list) list.innerHTML = libraryList();
  updatePlayers();
}
function refreshDetail() { render(); }

function loadAudio(rec) {
  if (!rec?.audioUrl) {
    if (rec) openDialog({type:'reconnect', recordingId:rec.id});
    return false;
  }
  if (state.audioId !== rec.id || audio.getAttribute('src') !== rec.audioUrl) {
    state.audioId = rec.id; state.playing = false; state.currentTime = 0;
    audio.src = rec.audioUrl; audio.playbackRate = state.rate; audio.load();
  }
  return true;
}
async function toggleAudio(rec) {
  if (!loadAudio(rec)) return;
  try {
    if (!audio.paused) audio.pause(); else await audio.play();
  } catch {
    notify('This audio format could not be played. Try WAV, MP3 or M4A.');
  }
}
function seekTo(rec, time, play = false) {
  if (!loadAudio(rec)) return;
  const target = Math.max(0, Math.min(Number(time) || 0, rec.duration || Infinity));
  state.pendingSeek = target;
  try { audio.currentTime = target; if (audio.readyState >= 1) state.pendingSeek = null; } catch {}
  if (play) audio.play().catch(() => notify('Press play to start this audio.'));
  updatePlayers();
}
function segmentAtPlaybackTime(segment) {
  return Number.isFinite(segment.start) && audio.currentTime >= segment.start && audio.currentTime < (segment.end ?? Infinity);
}
function updatePlayers() {
  $$('[data-player]').forEach(el => {
    const rec = recordById(el.dataset.player);
    if (!rec) return;
    const active = rec.id === state.audioId;
    const now = active ? audio.currentTime || 0 : 0;
    const play = $('[data-action="play"]', el);
    if (play) {
      const playing = active && !audio.paused;
      play.innerHTML = icon(playing ? 'pause' : 'play');
      play.setAttribute('aria-label',playing ? 'Pause audio' : 'Play audio');
      play.dataset.tooltip = playing ? 'Pause audio' : 'Play audio';
    }
    const seek = $('[data-seek]',el);
    if (seek && document.activeElement !== seek) seek.value = now;
    if (seek) { seek.max=Math.max(rec.duration,1); seek.style.setProperty('--progress', (rec.duration ? now / rec.duration * 100 : 0) + '%'); }
    const time = $('[data-time]',el);
    if (time) time.textContent = formatTime(now) + ' / ' + formatTime(rec.duration);
  });
  const playingRecord = recordById(state.audioId);
  const currentPassages = new Set(playingRecord?.segments.filter(segmentAtPlaybackTime).map(segment => String(segment.id)));
  $$('[data-segment]').forEach(el => {
    const current = el.dataset.recording === playingRecord?.id && currentPassages.has(el.dataset.segment);
    el.classList.toggle('is-current', current);
    if (current) el.setAttribute('aria-current','true'); else el.removeAttribute('aria-current');
  });
  // Keep the spoken line in view while listening, until the reader scrolls away on purpose.
  const listening = Boolean(playingRecord) && !audio.paused && route().id === playingRecord.id && state.detailTab === 'transcript';
  const pill = $('.follow-pill');
  if (pill) pill.hidden = !(listening && !state.follow);
  if (listening && state.follow && !$('.transcript-paragraph.is-editing')) {
    const line = $('.transcript-passage.is-current');
    if (line && line.dataset.segment !== state.followedSegment) {
      state.followedSegment = line.dataset.segment;
      const box = line.getBoundingClientRect();
      if (box.top < 120 || box.bottom > window.innerHeight - 200) line.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'center'});
    }
  }
}
function pauseFollowing() {
  if (!state.follow || audio.paused || route().view !== 'detail') return;
  state.follow = false; updatePlayers();
}
audio.addEventListener('timeupdate', updatePlayers);
audio.addEventListener('play', () => { state.playing = true; updatePlayers(); });
audio.addEventListener('pause', () => { state.playing = false; updatePlayers(); });
audio.addEventListener('ended', () => { state.playing = false; updatePlayers(); });
audio.addEventListener('loadedmetadata', () => {
  const rec = recordById(state.audioId);
  if (rec && Number.isFinite(audio.duration)) rec.duration = audio.duration;
  if (state.pendingSeek !== null) { audio.currentTime = state.pendingSeek; state.pendingSeek = null; }
  updatePlayers();
});
audio.addEventListener('error', () => { if (audio.getAttribute('src')) notify('Audio could not be loaded. Reconnect it or choose another format.'); });

function clearPreparedPdf() {
  if (state.dialog?.preparedPdf) URL.revokeObjectURL(state.dialog.preparedPdf.url);
}
function openDialog(config) {
  clearPreparedPdf();
  state.dialog = config;
  renderDialog();
}
function closeDialog() {
  clearPreparedPdf();
  state.dialog = null;
  const dialog = $('#demo-dialog');
  if (dialog) { dialog.close(); dialog.remove(); }
}
function dialogFrame(title, body, footer = '') {
  return `<div class="dialog-heading"><h2 id="dialog-title">${title}</h2>${button('x','Close dialog','close-dialog','','quiet')}</div><div class="dialog-body">${body}</div>${footer ? '<div class="dialog-footer">' + footer + '</div>' : ''}`;
}
function renderDialog() {
  let dialog = $('#demo-dialog');
  const previousFocus = dialog?.contains(document.activeElement) ? document.activeElement?.id : null;
  if (!dialog) {
    dialog = document.createElement('dialog'); dialog.id='demo-dialog'; dialog.className='demo-dialog'; dialog.tabIndex=-1; dialog.setAttribute('aria-labelledby','dialog-title');
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
    dialog.addEventListener('click', event => { if (event.target === dialog) { const b=dialog.getBoundingClientRect(); if (event.clientX<b.left || event.clientX>b.right || event.clientY<b.top || event.clientY>b.bottom) closeDialog(); } });
    document.body.append(dialog);
  }
  const d=state.dialog, rec=recordById(d.recordingId);
  dialog.dataset.dialogType = d.type;
  let content = '';
  if (d.type === 'info') {
    const mode=transcriptionMode();
    content=dialogFrame('About Duowen',`<p class="dialog-lead">Listen, find the moment, and make the transcript yours.</p><div class="info-feature">${icon('waveform')}<div><h3>Your recordings, your library</h3><p>Only recordings you add appear here. Each one gets a timestamped transcript with speakers you can rename.</p></div></div><div class="info-feature">${icon('lock-key')}<div><h3>Audio & privacy</h3><p>${mode.configured?`Audio and video are sent to ${esc(mode.label)} for transcription.`:'Audio and video uploads are unavailable.'} Your transcript and edits are saved in this browser.</p></div></div>${providerDetails(mode)}<div class="info-feature">${icon('sparkle')}<div><h3>Automatic, with clear feedback</h3><p>New recordings are transcribed automatically. Processing states reflect the actual job. Speaker separation is shown only when the service returns it; saved names do not perform voice matching.</p></div></div><p class="fine-print">Recordings, transcripts and edits are kept in this browser only. Clearing site data removes them.</p>`,
      '<button class="quiet-link" data-action="confirm-reset">' + icon('trash') + 'Clear library</button><button class="button primary" data-action="close-dialog">Done</button>');
  } else if (d.type === 'speaker') {
    const speaker=speakerById(rec,d.speakerId);
    content=dialogFrame('Edit speaker',`<form id="speaker-form"><label class="field-label" for="speaker-name">Display name</label><input class="text-input" id="speaker-name" name="name" required maxlength="100" value="${esc(displayName(speaker))}" autocomplete="off">
      ${speaker.suggestedName && speaker.confirmed===false ? `<div class="suggested-person"><span class="panel-kicker">Sample suggestion · not voice recognition</span><strong>${esc(speaker.suggestedName)}</strong><div><button type="button" class="text-button" data-action="use-suggested" data-name="${esc(speaker.suggestedName)}">Use this name</button><button type="button" class="quiet-link" data-action="reject-suggested">Not this person</button></div></div>` : ''}
      ${state.knownSpeakers.length ? '<div class="saved-names"><span class="field-label">Choose a saved name</span><div>' + state.knownSpeakers.map(s => '<button type="button" class="name-choice" data-action="choose-name" data-name="' + esc(s.name) + '">' + icon('user') + esc(s.name) + '</button>').join('') + '</div></div>' : ''}
      <fieldset class="scope-options" ${d.segmentId ? '' : 'hidden'}><legend>Apply to</legend><label><input type="radio" name="scope" value="speaker" ${d.scope!=='segment'?'checked':''}><span>${speaker.id === 'unassigned' ? 'All currently unassigned segments' : 'This speaker throughout this recording'}</span></label>${d.segmentId ? '<label><input type="radio" name="scope" value="segment" ' + (d.scope==='segment'?'checked':'') + '><span>' + (d.segmentIds?.length > 1 ? 'Only this paragraph' : 'Only this passage') + '</span></label>' : ''}</fieldset>
      <label class="check-label"><input type="checkbox" name="saveName"><span>Save this name for other recordings</span></label><p class="fine-print">Saving a name does not identify or learn someone’s voice.</p><div class="form-error" id="speaker-error" role="alert"></div>
      <div class="dialog-footer inline-footer"><button type="button" class="button secondary" data-action="close-dialog">Cancel</button><button type="submit" class="button primary">Save name</button></div></form>`);
  } else if (d.type === 'speakers') {
    content=hasUnassignedSegments(rec) ? dialogFrame('Assign speakers',`<p class="dialog-lead">Choose a passage to assign or correct its speaker.</p><div class="speaker-list segment-assignment-list">${rec.segments.map(s=>`<button class="speaker-list-row" data-action="speaker" data-id="${esc(rec.id)}" data-speaker-id="${esc(s.speakerId)}" data-segment-id="${esc(s.id)}" data-scope="segment"><span class="assignment-time">${formatTime(s.start)}</span><span><strong>${esc(displayName(speakerById(rec,s.speakerId)))}</strong><small>${esc(s.text)}</small></span>${icon('pencil-simple')}</button>`).join('')}</div>`) : dialogFrame('Speakers',`<p class="dialog-lead">Names belong to this recording. Change one without changing other files.</p><div class="speaker-list">${rec.speakers.filter(s=>rec.segments.some(t=>t.speakerId === s.id)).map(s=>`<button class="speaker-list-row" data-action="speaker" data-id="${esc(rec.id)}" data-speaker-id="${esc(s.id)}"><span class="speaker-avatar">${icon('user')}</span><span><strong>${esc(displayName(s))}</strong><small>${rec.segments.filter(t=>t.speakerId===s.id).length} segments${s.confirmed===false?' · Unconfirmed':''}</small></span>${icon('pencil-simple')}</button>`).join('')}</div>`);
  } else if (d.type === 'rename') {
    content=dialogFrame('Rename recording',`<form id="rename-form"><label class="field-label" for="recording-title">Title</label><input id="recording-title" name="title" class="text-input" value="${esc(rec.title)}" maxlength="250" required><p class="fine-print">Original file: ${esc(rec.originalFilename)}</p><div class="dialog-footer inline-footer"><button type="button" class="button secondary" data-action="close-dialog">Cancel</button><button type="submit" class="button primary">Save title</button></div></form>`);
  } else if (d.type === 'project-form') {
    const project = projectById(d.projectId);
    content=dialogFrame(project ? 'Rename project' : 'New project',`<form id="project-form"><label class="field-label" for="project-name">Project name</label><input id="project-name" name="name" class="text-input" value="${esc(project?.name || '')}" maxlength="80" placeholder="e.g. Playtest round 1" autocomplete="off" required>${project ? '' : `<p class="fine-print">${rec ? 'This recording will be filed in the new project.' : 'Recordings you drop on the project page are filed in it.'}</p>`}<div class="dialog-footer inline-footer"><button type="button" class="button secondary" data-action="close-dialog">Cancel</button><button type="submit" class="button primary">${project ? 'Save name' : 'Create project'}</button></div></form>`);
  } else if (d.type === 'move') {
    const row = (projectId, label, detail, name) => `<button type="button" class="speaker-list-row ${(rec.projectId || '') === projectId && (!rec.projectId || projectById(rec.projectId)) ? 'is-current' : ''}" data-action="assign-project" data-id="${esc(rec.id)}" data-project-id="${esc(projectId)}"><span class="speaker-avatar">${icon(name)}</span><span><strong>${esc(label)}</strong><small>${esc(detail)}</small></span>${(rec.projectId || '') === projectId ? icon('check') : ''}</button>`;
    content=dialogFrame('Move to project',`<div class="speaker-list">${state.projects.map(project => row(project.id, project.name, projectSummary(project.id), 'folder')).join('')}${row('', 'No project', 'Keep it only in the Library', 'tray')}<button type="button" class="speaker-list-row" data-action="new-project" data-id="${esc(rec.id)}"><span class="speaker-avatar">${icon('plus')}</span><span><strong>New project…</strong><small>Create one and file this recording in it</small></span></button></div>`);
  } else if (d.type === 'project-menu') {
    const project = projectById(d.projectId);
    content=dialogFrame('Project actions',`<div class="action-menu"><button data-action="rename-project" data-project-id="${esc(project.id)}">${icon('pencil-simple')}Rename</button><button class="danger-text" data-action="confirm-delete-project" data-project-id="${esc(project.id)}">${icon('trash')}Delete project</button></div>`);
  } else if (d.type === 'confirm-delete-project') {
    const project = projectById(d.projectId);
    content=dialogFrame('Delete project?', '<p>Delete <strong>' + esc(project.name) + '</strong>. Its ' + projectRecordings(project.id).length + ' recording(s) stay in your Library, without a project.</p>',
      '<button class="button secondary" data-action="close-dialog">Keep project</button><button class="button danger" data-action="delete-project" data-project-id="' + esc(project.id) + '">Delete project</button>');
  } else if (d.type === 'ai-pack') {
    const {name, recs, ready} = packSource(d);
    const pack = buildContextPack(name, recs, d.task ?? DEFAULT_PACK_TASK);
    const tokens = estimateTokens(pack), waiting = recs.length - ready.length;
    const size = tokens >= 1000 ? Math.round(tokens / 1000) + 'k' : String(tokens);
    content=dialogFrame('Send to AI',`<p class="dialog-lead"><strong>${ready.length} transcript${ready.length === 1 ? '' : 's'}</strong> from ${esc(name)}, packed as one Markdown file that an AI assistant can read in a single pass.</p>
      <div class="pack-facts"><span>${icon('files')}${ready.length} recording${ready.length === 1 ? '' : 's'}</span><span>${icon('clock')}${esc(durationLabel(ready.reduce((sum, r) => sum + (r.duration || 0), 0)))}</span><span>${icon('text-aa')}about ${size} tokens</span></div>
      ${waiting ? `<div class="notice">${icon('info')}<span>${waiting} recording${waiting === 1 ? ' is' : 's are'} still being transcribed or failed, and ${waiting === 1 ? 'is' : 'are'} left out.</span></div>` : ''}
      ${tokens > 150000 ? `<div class="notice">${icon('warning-circle')}<span>This is a lot of text. Some assistants may not accept it in one message; downloading the file and attaching it usually works better than pasting.</span></div>` : ''}
      <label class="field-label" for="pack-task">What should the assistant do? <span class="field-hint">Included at the top of the file. Edit or clear it.</span></label><textarea id="pack-task" rows="6">${esc(d.task ?? DEFAULT_PACK_TASK)}</textarea>
      <div class="pack-actions"><button type="button" class="button primary" data-action="pack-open" data-target="claude">${icon('copy')}Copy and open Claude</button><button type="button" class="button primary" data-action="pack-open" data-target="chatgpt">${icon('copy')}Copy and open ChatGPT</button></div>
      <p class="fine-print">The whole pack is copied to your clipboard and a new chat opens in another tab. Paste it there (⌘V or Ctrl+V) and send. Long text is turned into an attachment automatically.</p>`,
      `<button type="button" class="quiet-link" data-action="pack-copy">${icon('copy')}Copy only</button><button type="button" class="button secondary" data-action="pack-download">${icon('download-simple')}Download .md</button>`);
  } else if (d.type === 'recording-menu') {
    content=dialogFrame('Recording actions',`<div class="action-menu"><button data-action="rename-recording" data-id="${esc(rec.id)}">${icon('pencil-simple')}Rename</button><button data-action="move" data-id="${esc(rec.id)}">${icon('folder')}Move to project…</button>${rec.segments.length ? `<button data-action="ai-pack" data-id="${esc(rec.id)}">${icon('sparkle')}Send to AI</button>` : ''}${rec.segments.length ? `<button data-action="copy-transcript" data-id="${esc(rec.id)}">${icon('copy')}Copy transcript</button><button data-action="export" data-id="${esc(rec.id)}">${icon('download-simple')}Export transcript</button>` : ''}${rec.audioUrl ? '' : `<button data-action="reconnect" data-id="${esc(rec.id)}">${icon('link')}Reconnect audio</button>`}<button data-action="import-transcript" data-id="${esc(rec.id)}" ${isTranscribing(rec)?'disabled':''}>${icon('file-text')}Replace with a subtitle file</button><button class="danger-text" data-action="confirm-remove" data-id="${esc(rec.id)}">${icon('trash')}Remove from this library</button></div>`);
  } else if (d.type === 'export' && d.preparedPdf) {
    const { url, filename } = d.preparedPdf;
    content=dialogFrame('Export transcript', '<p class="dialog-lead" role="status">Your PDF is ready to save.</p>',
      `<a id="save-transcript-pdf" class="button primary" href="${esc(url)}" download="${esc(filename)}">${icon('download-simple')}Save PDF</a>`);
  } else if (d.type === 'export') {
    content=dialogFrame('Export transcript',`<p class="dialog-lead">Names and text include your latest changes.</p>${state.exportingFormat ? '<div class="export-progress" role="status">' + icon('circle-notch') + '<span>Preparing ' + esc(state.exportingFormat === 'docx' ? 'Word document' : state.exportingFormat.toUpperCase()) + '…</span></div>' : ''}<div class="export-options">${(()=>{const option=o=>`<button data-action="download" data-format="${o.id}" data-id="${esc(rec.id)}" ${state.exportingFormat ? 'disabled' : ''}>${icon(o.icon)}<span><strong>${o.label}</strong><small>${o.desc}</small></span>${icon('download-simple')}</button>`;const all=[{id:'pdf',label:'PDF',desc:'A clean, paginated transcript for reading or sharing',icon:'file-pdf'},{id:'docx',label:'Word (.docx)',desc:'An editable Word document with speakers and times',icon:'file-doc'},{id:'txt',label:'Plain text',desc:'Readable transcript with speakers and times',icon:'file-text'},{id:'md',label:'Markdown',desc:'Structured text for your notes or knowledge base',icon:'file-md'},{id:'srt',label:'SRT subtitles',desc:'Timestamped subtitles for video editors',icon:'subtitles'},{id:'vtt',label:'WebVTT',desc:'Timestamped captions for the web',icon:'closed-captioning'},{id:'json',label:'JSON',desc:'Segments, speakers, notes and file metadata',icon:'brackets-curly'}];return all.slice(0,3).map(option).join('')+'<details class="more-formats"'+(['md','srt','vtt','json'].includes(state.exportingFormat)?' open':'')+'><summary>More formats</summary><div class="export-options">'+all.slice(3).map(option).join('')+'</div></details>';})()}</div>`);
  } else if (d.type === 'reconnect') {
    content=dialogFrame('Reconnect audio',`<p class="dialog-lead">Choose <strong>${esc(rec.originalFilename)}</strong> again ${rec.segments.length?'to listen':'to resume transcription'}.</p><p class="fine-print">${rec.segments.length?'Your transcript and edits are saved.':'You do not need to upload a transcript file.'} This browser no longer has the audio, which can happen in a private window or after site data is cleared.</p>`,
      '<button class="button secondary" data-action="close-dialog">Cancel</button><button class="button primary" data-action="choose-reconnect" data-id="' + esc(rec.id) + '">Choose audio file</button>');
  } else if (d.type === 'confirm-reset') {
    content=dialogFrame('Clear your library?', '<p>Every recording, transcript, edit and saved speaker name will be removed from this browser. Your original files will not be changed.</p>',
      '<button class="button secondary" data-action="close-dialog">Keep everything</button><button class="button danger" data-action="reset">Clear library</button>');
  } else if (d.type === 'confirm-remove') {
    content=dialogFrame('Remove recording?', '<p>Remove <strong>' + esc(rec.title) + '</strong> and its edits from your library. Your original file will not be changed.</p>',
      '<button class="button secondary" data-action="close-dialog">Keep recording</button><button class="button danger" data-action="remove-recording" data-id="' + esc(rec.id) + '">Remove</button>');
  }
  dialog.innerHTML=content;
  if (!dialog.open) dialog.showModal();
  const field = $('.text-input', dialog);
  if (previousFocus && $('#'+previousFocus,dialog)) $('#'+previousFocus,dialog).focus();
  else if (field) { field.focus(); field.select(); }
  else ($('.dialog-footer .button.primary, .dialog-footer .button.danger', dialog) || dialog).focus({preventScroll:true});
  if (!previousFocus) dialog.scrollTop = 0;
}

function rememberUndo(message,recordingId) {
  const rec=recordById(recordingId);if(!rec)return;
  state.undo={recording:clone(rec),index:state.recordings.indexOf(rec),file:localFiles.get(rec.id),knownSpeakers:clone(state.knownSpeakers),message};
}
function restoreUndo() {
  const previous=state.undo;if(!previous)return;
  const saved=previous.recording,current=recordById(saved.id);
  // Undo one user action, never replace unrelated records changed by async jobs.
  if(current) {
    if(previous.message==='Title updated')current.title=saved.title;
    else Object.assign(current,saved);
  } else {
    if(activeStages.has(saved.status)) {
      saved.status='cancelled';saved.transcription={...saved.transcription,status:'cancelled',stage:'cancelled'};delete saved.transcription.job;
    }
    state.recordings.splice(Math.min(previous.index,state.recordings.length),0,saved);
    if(previous.file)localFiles.set(saved.id,previous.file);
  }
  state.knownSpeakers=previous.knownSpeakers;state.undo=null;persist();render();notify('Change undone.');
}
function clearAudio() {
  audio.pause(); audio.removeAttribute('src'); audio.load(); state.audioId=null; state.playing=false; state.pendingSeek=null;
}
function askQuestion(rec, query) {
  const clean=query.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').trim();
  const words=clean.split(/\s+/).filter(w=>w.length>2&&!['what','when','where','which','does','did','the','and','was','were','are','for','this','that','with','about','can','you','they','how','who','from','have','has','been','said','say','would','could','should'].includes(w));
  const prepared=(rec.notesStale?[]:rec.qa||[]).map(q=>{
    const qw=q.question.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').trim();
    const overlap=words.filter(w=>qw.includes(w)).length;
    return {q,score:qw===clean?100:words.length?overlap/words.length:0};
  }).sort((a,b)=>b.score-a.score)[0];
  if (prepared && prepared.score===100) state.answer={...prepared.q,question:query};
  else {
    const matches=rec.segments.map(s=>({s,score:words.reduce((n,w)=>n+((s.text+' '+displayName(speakerById(rec,s.speakerId))).toLowerCase().includes(w)?1:0),0)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,3);
    state.answer=matches.length ? {question:query,answer:'These passages are the closest matches in this transcript. Open a source to hear the context.',excerpt:matches.map(x=>displayName(speakerById(rec,x.s.speakerId))+': '+x.s.text).join('\n\n'),citationSegmentIds:matches.map(x=>x.s.id)} : {question:query,answer:'I could not find a matching passage in this transcript. Try a phrase, speaker name, or one of the sample questions.',citationSegmentIds:[]};
  }
  render();
  $('#question-input')?.focus();
}
function chooseFiles(mode='upload', id=null) {
  const service=transcriptionMode();
  if(mode==='upload' && service.engine==='deepgram' && !service.configured){notify(service.configurationError);return;}
  const input=document.createElement('input'); input.type='file'; input.accept='audio/*,video/*,.m4a,.mp3,.wav,.aac,.aiff,.ogg,.flac,.mp4,.mov,.webm'; input.multiple=mode==='upload';
  input.hidden = true;
  input.addEventListener('cancel', () => input.remove(), { once: true });
  input.addEventListener('change',async()=>{
    input.remove();
    if (!input.files?.length) return;
    if (mode==='reconnect') {
      const rec=recordById(id); if (!rec) return;
      const file=input.files[0];
      if(rec.source==='local-upload' && (file.name!==rec.originalFilename || rec.size && file.size!==rec.size)){notify('Choose the original '+rec.originalFilename+'. Add a different file as a new recording.');return;}
      const url=URL.createObjectURL(file);
      const result=await audioMetadata(url);
      if (state.audioId===rec.id) clearAudio();
      if (rec.audioUrl?.startsWith('blob:')) URL.revokeObjectURL(rec.audioUrl);
      rec.audioUrl=url; rec.needsAudio=false; rec.duration=result.duration || rec.duration;
      localFiles.set(rec.id,file);storeAudio(rec.id,file);
      closeDialog();
      if (!rec.segments.length) queueTranscription(rec,file);
      else { rec.status='ready';persist();render();notify('Audio reconnected.'); }
    } else receiveFiles([...input.files]);
  }, { once: true });
  document.body.append(input);
  input.click();
}
// Dropping a file is the whole request: transcription starts without a confirmation step.
function receiveFiles(files) {
  const mode=transcriptionMode();
  if(mode.configured===false){notify(mode.configurationError);return;}
  const fits=file=>!Number.isFinite(mode.maxUploadBytes) || file.size<=mode.maxUploadBytes;
  const accepted=files.filter(fits),skipped=files.filter(file=>!fits(file));
  if(!accepted.length){notify((skipped.length===1?skipped[0].name+' is':'These files are')+` over the ${mode.uploadLimit} limit. Try a shorter or compressed copy.`);return;}
  state.pendingFiles=accepted;addPendingFiles();
  if(skipped.length)notify(skipped.length+' file'+(skipped.length===1?'':'s')+` over ${mode.uploadLimit} ${skipped.length===1?'was':'were'} skipped.`);
}
function audioMetadata(url) {
  return new Promise(resolve=>{
    const probe=new Audio(); let done=false;
    const finish=result=>{if(done)return;done=true;clearTimeout(timer);probe.removeAttribute('src');probe.load();resolve(result);};
    const timer=setTimeout(()=>finish({duration:0,error:true}),7000);
    probe.addEventListener('loadedmetadata',()=>finish({duration:Number.isFinite(probe.duration)?probe.duration:0,error:false}),{once:true});
    probe.addEventListener('error',()=>finish({duration:0,error:true}),{once:true});
    probe.preload='metadata';probe.src=url;
  });
}
function refreshTranscriptionViews(rec, rebuild=false) {
  if (!recordById(rec.id)) return;
  if (rebuild) {
    if (route().view==='library') refreshList();
    else if (route().id===rec.id || ['upload','project'].includes(route().view)) render();
    return;
  }
  const current=status(rec);
  $$('[data-recording-status]').filter(el=>el.dataset.recordingStatus===rec.id).forEach(el=>{
    if(el.dataset.statusKey!==current.key)el.outerHTML=statusMarkup(rec);
    else {const detail=$('.status-detail',el);if(detail && detail.textContent!==current.detail)detail.textContent=current.detail || '';}
  });
  $$('[data-mobile-status]').filter(el=>el.dataset.mobileStatus===rec.id).forEach(el=>{el.className='detail-mobile-status state-'+current.key;el.innerHTML=icon(icons[current.key] || 'info')+'<span>'+esc(current.label)+(current.detail?' · '+esc(current.detail):'')+'</span>';});
  $$('[data-processing-view]').filter(el=>el.dataset.processingView===rec.id).forEach(el=>{
    const visual=$('.processing-visual',el);if(!visual)return;
    const progress=state.processing[rec.id];if(!progress)return;
    const retention=$('[data-job-retention]',el);if(retention)retention.textContent=cancellationRetention(rec);
    const actions=$('.processing-actions',el),actionsMarkup=cancellationActions(rec);if(actions && actions.innerHTML!==actionsMarkup)actions.innerHTML=actionsMarkup;
    if(visual.dataset.stage!==progress.key) {visual.innerHTML=processingVisual(rec);visual.dataset.stage=progress.key;return;}
    const description=$('.processing-description',visual);if(description && description.textContent!==progress.detail && progress.detail)description.textContent=progress.detail;
    const meta=$('.job-progress-meta > span',visual);if(meta)meta.textContent=progressLabel(progress) || 'Processing your recording';
    const bar=$('.job-progress',visual),fill=$('.job-progress > span',visual),known=Number.isFinite(progress.percent);
    bar?.classList.toggle('is-indeterminate',!known);
    if(bar && known){bar.setAttribute('aria-valuemin','0');bar.setAttribute('aria-valuemax','100');bar.setAttribute('aria-valuenow',Math.round(progress.percent));}
    else if(bar){bar.removeAttribute('aria-valuenow');bar.removeAttribute('aria-valuemin');bar.removeAttribute('aria-valuemax');}
    if(fill)fill.style.width=known?progress.percent+'%':'';
  });
}
function queueTranscription(rec,file,{resumeJob=null}={}) {
  const mode=transcriptionMode();
  if (!resumeJob && mode.configured===false) {
    rec.status='error';rec.transcription={...rec.transcription,status:'error',error:mode.configurationError};
    persist();refreshTranscriptionViews(rec,true);notify(mode.configurationError);return;
  }
  if (transcriptionJobs.has(rec.id)) return;
  const job={id:uid(),recordingId:rec.id,file,resumeJob,controller:new AbortController()};
  if(file)localFiles.set(rec.id,file);transcriptionJobs.set(rec.id,job);transcriptionQueue.push(job);
  const previous=rec.transcription;
  const cancelling=Boolean(resumeJob && previous?.cancelRequestedAt);
  rec.status=cancelling?(previous.cancellationError?'cancellation-unconfirmed':'cancelling'):'queued';rec.transcription={status:rec.status,stage:rec.status,engine:resumeJob?'whisperx':mode.engine,queuedAt:resumeJob && previous?.queuedAt || Date.now(),...(resumeJob?{job:resumeJob,startedAt:previous?.startedAt,...(cancelling?{cancelRequestedAt:previous.cancelRequestedAt,cancellationError:previous.cancellationError}:{})}:{})};
  state.processing[rec.id]=cancelling?{key:rec.status,label:previous.cancellationError?'Cancellation not confirmed':'Cancelling',detail:previous.cancellationError || 'Checking the cloud job for confirmation.'}:{key:'queued',label:'Queued',detail:activeTranscription?'Waiting for the previous recording to finish.':'Preparing to start transcription.'};
  persist();refreshTranscriptionViews(rec,true);pumpTranscriptionQueue();
}
async function pumpTranscriptionQueue() {
  if (activeTranscription) return;
  const job=transcriptionQueue.shift();if(!job)return;
  const rec=recordById(job.recordingId);
  if (!rec || transcriptionJobs.get(job.recordingId)!==job || job.controller.signal.aborted) {pumpTranscriptionQueue();return;}
  activeTranscription=job;
  const startedAt=job.resumeJob && Number.isFinite(rec.transcription?.startedAt)?rec.transcription.startedAt:Date.now();
  const alive=()=>recordById(rec.id)===rec && transcriptionJobs.get(rec.id)===job && !job.controller.signal.aborted;
  const labels={queued:'Queued',uploading:'Uploading audio','model-loading':'Preparing speech model',decoding:'Preparing audio',transcribing:'Transcribing',aligning:'Aligning timestamps',diarizing:'Separating speakers',cancelling:'Cancelling','cancellation-unconfirmed':'Cancellation not confirmed'};
  const update=progress=>{
    if(!alive())return;
    const cancelling=Boolean(rec.transcription?.cancelRequestedAt || progress.stage==='cancelling');
    const stage=cancelling?(rec.transcription?.cancellationError?'cancellation-unconfirmed':'cancelling'):activeStages.has(progress.stage)?progress.stage:'transcribing';
    rec.status=stage;rec.transcription={...rec.transcription,status:cancelling?stage:'processing',stage,startedAt,...(cancelling?{cancelRequestedAt:rec.transcription?.cancelRequestedAt || Date.now()}:{}),...(progress.job?{job:{id:progress.job.id,accessToken:progress.job.accessToken}}:{})};
    if(progress.job)persist();
    state.processing[rec.id]={key:stage,label:labels[stage],detail:cancelling?rec.transcription.cancellationError || 'Waiting for WhisperX to confirm that processing has stopped.':progress.detail || '',startedAt,
      ...(!cancelling && Number.isFinite(progress.percent)?{percent:Math.max(0,Math.min(100,progress.percent))}:{}),
      ...(!cancelling && Number.isFinite(progress.etaSeconds)?{etaSeconds:progress.etaSeconds}:{})};
    refreshTranscriptionViews(rec);
  };
  update({stage:'queued',detail:'Starting the transcription service.'});
  const ticker=setInterval(()=>{if(alive())refreshTranscriptionViews(rec);},1000);
  try {
    const result=await (job.resumeJob?resumeTranscription(job.resumeJob,{onProgress:update,signal:job.controller.signal}):transcribeFile(job.file,{onProgress:update,signal:job.controller.signal}));
    if(!alive())return;
    const segments=(result.segments || []).filter(segment=>String(segment.text || '').trim()).map((segment,index)=>({
      ...segment,id:rec.id+'-segment-'+index,text:String(segment.text).trim(),
      start:segment.start!==null && Number.isFinite(segment.start)?segment.start:null,
      end:segment.end!==null && Number.isFinite(segment.end)?segment.end:null,
      speakerId:segment.speakerId || 'unassigned'
    }));
    if(!segments.length)throw new Error('No speech was detected. Try a clearer recording or another audio file.');
    const normalized=normalize({...rec,...result,id:rec.id,source:'local-upload',segments,
      speakers:result.speakers || [],status:'ready',reviewStatus:'uncorrected-asr',asrDraft:true,
      notes:{summary:[],actions:[],decisions:[]},qa:[],notesStale:false,
      duration:result.duration || rec.duration,diarizationStatus:result.diarizationStatus || 'not-run'},0);
    Object.assign(rec,normalized);rec.transcription={...rec.transcription,status:'complete',stage:'ready',completedAt:Date.now(),engine:result.engine || 'whisperx'};delete rec.transcription.job;
    delete state.processing[rec.id];persist();refreshTranscriptionViews(rec,true);notify(rec.title+' · Transcript ready.');
  } catch(error) {
    if(!alive())return;
    const hasRemoteJob=Boolean(rec.transcription?.job?.accessToken),cancelled=error.code==='SERVER_CANCELLED' || error.cancellationConfirmed===true || rec.transcription?.cancelRequestedAt && ['HTTP_404','HTTP_410'].includes(error.code);
    if(cancelled || error.name==='AbortError' && !hasRemoteJob)confirmTranscriptionCancellation(rec);
    else if(hasRemoteJob && !['TRANSCRIPTION_FAILED','NO_SPEECH','HTTP_404','HTTP_410','INVALID_RESULT'].includes(error.code) && (rec.transcription.cancelRequestedAt || error.name==='AbortError' || error.code==='TRANSCRIPTION_TIMEOUT')) {
      const detail='The service has not confirmed that processing stopped. Check your connection, then retry cancellation or check status.';
      rec.status='cancellation-unconfirmed';rec.transcription={...rec.transcription,status:rec.status,stage:rec.status,cancelRequestedAt:rec.transcription.cancelRequestedAt || Date.now(),cancellationError:detail};
      state.processing[rec.id]={key:rec.status,label:'Cancellation not confirmed',detail};persist();refreshTranscriptionViews(rec,true);notify('Cancellation not confirmed. Your cloud job is saved so you can retry.');
    } else {
      rec.status='error';rec.transcription={...rec.transcription,status:'error',error:error.message || 'Transcription failed. Please retry this audio.'};
      if(['TRANSCRIPTION_FAILED','NO_SPEECH','HTTP_404','HTTP_410','INVALID_RESULT'].includes(error.code))delete rec.transcription.job;
      delete state.processing[rec.id];persist();refreshTranscriptionViews(rec,true);notify(rec.title+' · Transcription failed.');
    }
  } finally {
    clearInterval(ticker);
    if(transcriptionJobs.get(rec?.id)===job)transcriptionJobs.delete(rec.id);
    if(activeTranscription===job)activeTranscription=null;
    pumpTranscriptionQueue();
  }
}
function confirmTranscriptionCancellation(rec, stoppedWaiting=false) {
  const job=transcriptionJobs.get(rec.id);
  transcriptionJobs.delete(rec.id);job?.controller.abort();
  for(let i=transcriptionQueue.length-1;i>=0;i--)if(transcriptionQueue[i]===job)transcriptionQueue.splice(i,1);
  rec.status='cancelled';rec.transcription={...rec.transcription,status:'cancelled',stage:'cancelled',cancelledAt:Date.now(),...(stoppedWaiting?{stoppedWaiting:true}:{})};delete rec.transcription.job;delete rec.transcription.cancellationError;delete rec.transcription.cancelRequestInFlight;
  delete state.processing[rec.id];persist();refreshTranscriptionViews(rec,true);notify(stoppedWaiting?'Stopped waiting. Deepgram may still finish the request.':'Transcription cancelled.');
}
async function cancelTranscription(rec) {
  const remote=rec.transcription?.job;
  if(!remote?.accessToken) {
    const job=transcriptionJobs.get(rec.id);
    if(job)confirmTranscriptionCancellation(rec,rec.transcription?.engine==='deepgram' && activeTranscription===job);
    return true;
  }
  if(rec.transcription.cancelRequestInFlight)return false;
  rec.status='cancelling';rec.transcription={...rec.transcription,status:'cancelling',stage:'cancelling',cancelRequestedAt:rec.transcription.cancelRequestedAt || Date.now(),cancelRequestInFlight:true};delete rec.transcription.cancellationError;
  state.processing[rec.id]={key:'cancelling',label:'Cancelling',detail:'Sending the cancellation request to WhisperX.'};persist();refreshTranscriptionViews(rec,true);
  try {
    const result=await cancelTranscriptionJob(remote);
    if(recordById(rec.id)!==rec || rec.transcription?.job?.id!==remote.id || rec.transcription?.job?.accessToken!==remote.accessToken)return !rec.transcription?.job?.accessToken;
    if(['cancelled','deleted'].includes(result?.status)){confirmTranscriptionCancellation(rec);return true;}
    if(result?.status!=='cancelling')throw new Error('The service did not confirm the cancellation request.');
    delete rec.transcription.cancelRequestInFlight;state.processing[rec.id]={key:'cancelling',label:'Cancelling',detail:'WhisperX accepted cancellation. Waiting for processing to stop.'};persist();
    if(!transcriptionJobs.has(rec.id))queueTranscription(rec,null,{resumeJob:remote});
    else refreshTranscriptionViews(rec,true);
    return false;
  } catch(error) {
    if(recordById(rec.id)!==rec || !rec.transcription?.job?.accessToken)return true;
    if(['HTTP_404','HTTP_410'].includes(error.code)){confirmTranscriptionCancellation(rec);return true;}
    const detail='The cancellation request could not be confirmed. The cloud job may still be processing. Retry cancellation or check status.';
    rec.status='cancellation-unconfirmed';rec.transcription={...rec.transcription,status:rec.status,stage:rec.status,cancellationError:detail};delete rec.transcription.cancelRequestInFlight;
    state.processing[rec.id]={key:rec.status,label:'Cancellation not confirmed',detail};persist();refreshTranscriptionViews(rec,true);notify('Cancellation not confirmed. You can retry or check status.');return false;
  }
}
async function cancelAllTranscriptions() {
  const results=await Promise.all(state.recordings.filter(rec=>rec.transcription?.job?.accessToken || transcriptionJobs.has(rec.id)).map(cancelTranscription));
  return results.every(Boolean);
}
function addPendingFiles() {
  const files=[...state.pendingFiles];if(!files.length)return;
  const mode=transcriptionMode();
  if(mode.configured===false){notify(mode.configurationError);return;}
  if(files.some(file=>file.size>mode.maxUploadBytes)){notify(`Remove files over ${mode.uploadLimit} before transcribing.`);return;}
  closeDialog();state.pendingFiles=[];
  const batchId='local-'+uid(),uploadedAt=new Date().toISOString();
  const projectId=route().view==='project'?route().projectId:null;
  const added=files.map(file=>({...(projectId?{projectId}:{}),id:'local-'+uid(),title:file.name.replace(/\.[^.]+$/,'')||file.name,originalFilename:file.name,batchId,uploadedAt,duration:0,source:'local-upload',status:'queued',audioUrl:URL.createObjectURL(file),size:file.size,speakers:[],segments:[],notes:{summary:[],actions:[],decisions:[]},qa:[]}));
  state.recordings.unshift(...added);state.search='';state.libraryScroll=0;
  // One file opens straight into its transcript; a batch lands in the library.
  // Inside a project the recordings are filed there and the visitor stays on the project.
  if(!projectId)navigate(added.length===1?added[0].id:null);render();
  added.forEach((rec,index)=>{
    localFiles.set(rec.id,files[index]);storeAudio(rec.id,files[index]);queueTranscription(rec,files[index]);
    audioMetadata(rec.audioUrl).then(result=>{if(recordById(rec.id)===rec && result.duration){rec.duration=result.duration;persist();refreshTranscriptionViews(rec,true);}});
  });
  if(projectId)notify(files.length+' recording'+(files.length===1?'':'s')+' added to '+projectById(projectId).name+'.');
  else if(files.length>1)notify(files.length+' recordings queued for transcription.');
}
function parseTimestamp(value) {
  const parts=value.trim().replace(',','.').split(':').map(Number);
  if(parts.some(n=>!Number.isFinite(n)))return null;
  return parts.length===3?parts[0]*3600+parts[1]*60+parts[2]:parts.length===2?parts[0]*60+parts[1]:null;
}
function parseTranscript(text, filename) {
  const clean=text.replace(/^\uFEFF/,'').replace(/\r/g,'').trim();
  const rows=[];
  const blocks=clean.split(/\n\s*\n/);
  for(const block of blocks){
    const lines=block.split('\n');const timing=lines.findIndex(l=>l.includes('-->'));
    if(timing<0)continue;
    const match=lines[timing].match(/([\d:. ,]+)\s*-->\s*([\d:.,]+)/);
    if(!match)continue;
    const start=parseTimestamp(match[1]),end=parseTimestamp(match[2]);if(start===null||end===null||end<start)continue;
    let body=lines.slice(timing+1).join(' ').trim(),name='Speaker 1';
    const voice=body.match(/^<v(?:\.[^\s>]+)?\s+([^>]+)>/i);
    const prefix=body.match(/^([\p{L}\p{N} ._'-]{1,45}):\s+/u);
    if(voice){name=voice[1].trim();body=body.replace(voice[0],'');}
    else if(prefix){name=prefix[1].trim();body=body.slice(prefix[0].length);}
    body=body.replace(/<\/?[^>]+>/g,'').trim();
    if(body)rows.push({start,end,name,text:body});
  }
  if(!rows.length){
    if(/\.(srt|vtt)$/i.test(filename))throw new Error('No valid timestamped captions found. Check the SRT or VTT format.');
    let turn=null;
    const flush=()=>{if(turn?.text.trim())rows.push({...turn,text:turn.text.trim()});turn=null;};
    for(const line of clean.split('\n')){
      const text=line.trim();
      if(!text){flush();continue;}
      const prefix=text.match(/^([\p{L}\p{N} ._'-]{1,45}):\s+/u);
      if(prefix){flush();turn={start:null,end:null,name:prefix[1].trim(),text:text.slice(prefix[0].length)};}
      else if(turn)turn.text+='\n'+text;
      else turn={start:null,end:null,name:'Speaker 1',text};
    }
    flush();
  }
  if(!rows.length)throw new Error('This transcript is empty.');
  const speakers=[];
  const segments=rows.map((r,i)=>{
    let speaker=speakers.find(s=>s.name===r.name);
    if(!speaker){speaker={id:'import-speaker-'+speakers.length,name:r.name,confirmed:true};speakers.push(speaker);}
    return {id:'import-segment-'+i,start:r.start,end:r.end,speakerId:speaker.id,text:r.text};
  });
  return {speakers,segments};
}
function importTranscript(id) {
  const rec=recordById(id);if(!rec)return;
  const input=document.createElement('input');input.type='file';input.accept='.srt,.vtt,.txt,text/plain,text/vtt,application/x-subrip';
  input.addEventListener('change',async()=>{
    const file=input.files?.[0];if(!file)return;
    try{
      const parsed=parseTranscript(await file.text(),file.name);
      if(rec.transcription?.job?.accessToken && !await cancelTranscription(rec)){notify('Keep this recording until cloud cancellation is confirmed, then import the subtitle file.');return;}
      rememberUndo('Transcript replaced',rec.id);
      rec.transcription={status:'complete',stage:'ready',source:'subtitle-import'};
      rec.speakers=parsed.speakers;rec.segments=parsed.segments;rec.status='ready';rec.importedTranscript=file.name;rec.notes={summary:[],actions:[],decisions:[]};rec.qa=[];rec.notesStale=false;
      state.answer=null;persist();closeDialog();state.transcriptSearch='';render();notify('Transcript imported. '+parsed.segments.length+' segments added.','undo');
    }catch(error){notify(error.message);}
  });
  input.click();
}
async function downloadTranscript(rec,format) {
  if (state.exportingFormat) return;
  const exportDialog = state.dialog;
  const timed=rec.segments.filter(s=>s.start!==null&&s.end!==null);
  if((format==='srt'||format==='vtt')&&!timed.length){notify('This text has no timestamps. Export as plain text or JSON.');return;}
  const stamp=(seconds,comma=false)=>{
    const total=Math.max(0,Math.round(seconds*1000)),ms=total%1000,sec=Math.floor(total/1000)%60,min=Math.floor(total/60000)%60,h=Math.floor(total/3600000);
    return [h,min,sec].map(n=>String(n).padStart(2,'0')).join(':')+(comma?',':'.')+String(ms).padStart(3,'0');
  };
  let output,type='text/plain';
  if(format==='json'){const data=clone(rec);delete data.audioUrl;if(data.transcription)delete data.transcription.job;output=JSON.stringify(data,null,2);type='application/json';}
  else if(format==='srt'||format==='vtt')output=(format==='vtt'?'WEBVTT\n\n':'')+timed.map((s,i)=>(format==='srt'?i+1+'\n':'')+stamp(s.start,format==='srt')+' --> '+stamp(s.end,format==='srt')+'\n'+displayName(speakerById(rec,s.speakerId))+': '+s.text).join('\n\n');
  else output=rec.title+'\n'+rec.originalFilename+'\n\n'+rec.segments.map(s=>(s.start!==null?'['+formatTime(s.start)+'] ':'')+displayName(speakerById(rec,s.speakerId))+'\n'+s.text).join('\n\n');
  state.exportingFormat=format;
  if (state.dialog?.type === 'export') renderDialog();
  try {
    const result = ['pdf','docx','md','txt'].includes(format) ? await exportRecording(rec,format,{
      speakerName:id=>displayName(speakerById(rec,id)),timeZone:'America/New_York',
    }) : {blob:new Blob([output],{type:type+';charset=utf-8'}),filename:(rec.title.replace(/[<>:"/\\|?*]/g,'_')||'transcript')+'.'+format};
    if (format === 'pdf') {
      // A direct click on the prepared link supplies fresh browser user activation.
      if (state.dialog === exportDialog && exportDialog?.type === 'export') {
        exportDialog.preparedPdf = { url: URL.createObjectURL(result.blob), filename: result.filename };
      }
      return;
    }
    const url=URL.createObjectURL(result.blob),a=document.createElement('a');
    a.href=url;a.download=result.filename;document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),10000);notify('Transcript exported.');
    if (state.dialog?.type === 'export' && state.dialog.recordingId === rec.id) closeDialog();
  } catch (error) {
    notify('Export could not finish. '+(error.message || 'Please try again.'));
  } finally {
    state.exportingFormat=null;
    if (state.dialog?.type === 'export') renderDialog();
    if (state.dialog === exportDialog && exportDialog?.preparedPdf) $('#save-transcript-pdf')?.focus();
  }
}
function returnToSegment(rec,segmentId,play=true) {
  closeDialog();state.detailTab='transcript';state.transcriptSearch='';
  if(route().id!==rec.id)navigate(rec.id);else render();
  const segment=rec.segments.find(s=>s.id===segmentId);
  if(Number.isFinite(segment?.start))seekTo(rec,segment.start,play);
  requestAnimationFrame(()=>{const el=$('[data-segment="'+CSS.escape(segmentId)+'"]');el?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'center'});el?.classList.add('citation-target');setTimeout(()=>el?.classList.remove('citation-target'),1800);});
}
function followPlayback(rec) {
  state.follow = true; state.followedSegment = null;
  if (state.audioId !== rec.id) { notify('Start playback to follow the current moment.'); return; }
  // Between two sentences, fall back to the one that was just spoken.
  const segment = rec.segments.find(segmentAtPlaybackTime) || rec.segments.findLast(s => Number.isFinite(s.start) && s.start <= audio.currentTime);
  if (!segment) return;
  const selector = `#segment-${CSS.escape(segment.id)}`;
  if (!$(selector) && state.transcriptSearch) {
    state.transcriptSearch = '';
    $('#transcript-search').value = '';
    $('#transcript-turns').innerHTML = transcriptParagraphsMarkup(rec);
    syncSearch();
  }
  updatePlayers();
  $(selector)?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'center'});
}

document.addEventListener('click',async event=>{
  const recordingLink=event.target.closest('a.recording-main');
  if(recordingLink && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button===0){
    event.preventDefault();
    const id=recordingLink.closest('[data-recording-card]')?.dataset.recordingCard;
    if(id)navigate(id);
    return;
  }
  const card=event.target.closest('[data-recording-card]');
  if(card && !event.target.closest('button,a,input,select,textarea,label,[contenteditable]') && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button===0 && !window.getSelection()?.toString()) {
    navigate(card.dataset.recordingCard);return;
  }
  if (event.target.closest('.upload-dropzone') && !event.target.closest('button,a,input')) { chooseFiles(); return; }
  const passage=event.target.closest('.transcript-passage');
  if(passage && !event.target.closest('.is-editing') && !window.getSelection()?.toString()) {
    // Any sentence is a play button: click the words to hear them.
    const rec=recordById(passage.dataset.recording),segment=rec?.segments.find(s=>String(s.id)===passage.dataset.segment);
    $$('.transcript-paragraph.is-selected').forEach(el=>el.classList.remove('is-selected'));
    passage.closest('.transcript-paragraph')?.classList.add('is-selected');
    if(Number.isFinite(segment?.start)){state.follow=true;state.followedSegment=segment.id;seekTo(rec,segment.start,true);}
    return;
  }
  const target=event.target.closest('[data-action]');if(!target)return;
  const action=target.dataset.action;const rec=recordById(target.dataset.id || state.dialog?.recordingId);
  event.preventDefault();
  if(action==='back'){navigate();return;}
  if(action==='go-library'){goToPage('library');return;}
  if(action==='go-upload'||action==='upload'){goToPage('upload');return;}
  if(action==='open'){navigate(rec.id);return;}
  if(action==='clear-search'){state.search='';render();return;}
  if(action==='info'){openDialog({type:'info'});return;}
  if(action==='choose-upload'){chooseFiles();return;}
  if(action==='library-view'){state.libraryView=target.dataset.view;state.collapsedBatches.clear();render();return;}
  if(action==='new-project'){openDialog({type:'project-form',recordingId:target.dataset.id || null});return;}
  if(action==='rename-project'){openDialog({type:'project-form',projectId:target.dataset.projectId});return;}
  if(action==='project-menu'){openDialog({type:'project-menu',projectId:target.dataset.projectId});return;}
  if(action==='confirm-delete-project'){openDialog({type:'confirm-delete-project',projectId:target.dataset.projectId});return;}
  if(action==='delete-project'){
    const project=projectById(target.dataset.projectId);if(!project)return;
    state.recordings.forEach(r=>{if(r.projectId===project.id)delete r.projectId;});
    state.projects=state.projects.filter(p=>p!==project);persist();closeDialog();goToPage('library');render();notify(project.name+' deleted. Its recordings are still in your Library.');return;
  }
  if(action==='move'){openDialog({type:'move',recordingId:rec.id});return;}
  if(action==='assign-project'){
    const project=projectById(target.dataset.projectId);
    if(project)rec.projectId=project.id;else delete rec.projectId;
    persist();closeDialog();render();notify(project?'Moved to '+project.name+'.':'Removed from its project.');return;
  }
  if(action==='ai-pack'){openDialog(target.dataset.projectId?{type:'ai-pack',projectId:target.dataset.projectId}:{type:'ai-pack',recordingId:rec.id});return;}
  if(['pack-open','pack-copy','pack-download'].includes(action)){
    const {name,recs}=packSource(state.dialog),pack=buildContextPack(name,recs,$('#pack-task')?.value ?? DEFAULT_PACK_TASK);
    state.dialog.task=$('#pack-task')?.value;
    if(action==='pack-download'){
      const url=URL.createObjectURL(new Blob([pack],{type:'text/markdown;charset=utf-8'})),a=document.createElement('a');
      a.href=url;a.download=(name.replace(/[<>:"/\\|?*]/g,'_')||'transcripts')+' - transcript pack.md';document.body.append(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),10000);notify('Pack downloaded. Attach it to a chat with your assistant.');return;
    }
    // Start the copy and open the tab in the same click, before the browser forgets the gesture.
    const copying=navigator.clipboard?.writeText(pack);
    if(action==='pack-open')window.open(target.dataset.target==='claude'?'https://claude.ai/new':'https://chatgpt.com/','_blank','noopener');
    try{await copying;if(!copying)throw new Error();notify(action==='pack-open'?'Pack copied. Paste it into the new chat.':'Pack copied to your clipboard.');}
    catch{notify('Copying was blocked by the browser. Use Download .md and attach the file instead.');}
    return;
  }
  if(action==='close-dialog'){closeDialog();return;}
  if(action==='batch'){const id=target.dataset.batchId;if(state.collapsedBatches.has(id))state.collapsedBatches.delete(id);else state.collapsedBatches.add(id);refreshList();return;}
  if(action==='play'){state.follow=true;toggleAudio(rec);return;}
  if(action==='skip'){seekTo(rec,(state.audioId===rec.id?audio.currentTime:0)+Number(target.dataset.delta),false);return;}
  if(action==='copy-transcript'){if(state.dialog)closeDialog();copyText(transcriptText(rec),'Transcript copied.');return;}
  if(action==='copy-paragraph'){const paragraph=paragraphById(rec,target.dataset.paragraphId);if(paragraph)copyText(paragraph.text,'Paragraph copied.');return;}
  if(action==='edit-paragraph'){startParagraphEdit(target.closest('.transcript-paragraph'));return;}
  if(action==='save-edit'||action==='cancel-edit'){finishParagraphEdit(action==='save-edit');return;}
  if(action==='search-step'){state.searchIndex+=Number(target.dataset.step);syncSearch(true);return;}
  if(action==='speaker' && target.dataset.paragraphId){const paragraph=paragraphById(rec,target.dataset.paragraphId);if(paragraph)openDialog({type:'speaker',recordingId:rec.id,speakerId:paragraph.speakerId,segmentId:paragraph.segments[0].id,segmentIds:paragraph.segments.map(s=>s.id),scope:'segment'});return;}
  if(action==='speaker'){openDialog({type:'speaker',recordingId:rec.id,speakerId:target.dataset.speakerId,segmentId:target.dataset.segmentId,scope:target.dataset.scope || (target.dataset.speakerId === 'unassigned' && target.dataset.segmentId ? 'segment' : 'speaker')});return;}
  if(action==='manage-speakers'){openDialog({type:'speakers',recordingId:rec.id});return;}
  if(action==='choose-name'||action==='use-suggested'){$('#speaker-name').value=target.dataset.name;$('#speaker-name').focus();return;}
  if(action==='reject-suggested'){const s=speakerById(rec,state.dialog.speakerId);delete s.suggestedName;persist();renderDialog();notify('Suggestion dismissed. Choose the right name.');return;}
  if(action==='seek-segment'){const segment=rec?.segments.find(s=>s.id===target.dataset.segmentId);if(Number.isFinite(segment?.start)){if(state.dialog)closeDialog();state.follow=true;seekTo(rec,segment.start,true);}return;}
  if(action==='cite'){returnToSegment(rec,target.dataset.segmentId,true);return;}
  if(action==='follow'){followPlayback(rec);return;}
  if(action==='tab'){state.detailTab=target.dataset.tab;state.answer=null;render();$('#tab-'+state.detailTab)?.focus({preventScroll:true});return;}
  if(action==='ask-suggested'){const q=rec.qa[Number(target.dataset.questionIndex)];state.answer={...q};render();return;}
  if(action==='rename-recording'){openDialog({type:'rename',recordingId:rec.id});return;}
  if(action==='recording-menu'){openDialog({type:'recording-menu',recordingId:rec.id});return;}
  if(action==='import-transcript'){if(!isTranscribing(rec))importTranscript(rec.id);return;}
  if(action==='export'){if(!rec.segments.length){notify(isTranscribing(rec)?'Transcription is still in progress. Export will be available when it finishes.':'No transcript is available yet. Resume transcription first.');return;}openDialog({type:'export',recordingId:rec.id});return;}
  if(action==='download'){downloadTranscript(rec,target.dataset.format);return;}
  if(action==='reconnect'){openDialog({type:'reconnect',recordingId:rec.id});return;}
  if(action==='choose-reconnect'){chooseFiles('reconnect',rec.id);return;}
  if(action==='retry-transcription'){const file=localFiles.get(rec.id);if(transcriptionJobs.has(rec.id)){notify('Checking the cloud job for its latest status.');refreshTranscriptionViews(rec,true);}else if(rec.transcription?.job?.accessToken)queueTranscription(rec,null,{resumeJob:rec.transcription.job});else if(file)queueTranscription(rec,file);else openDialog({type:'reconnect',recordingId:rec.id});return;}
  if(action==='cancel-transcription'){cancelTranscription(rec);return;}
  if(action==='confirm-reset'){openDialog({type:'confirm-reset'});return;}
  if(action==='reset'){
    if(!await cancelAllTranscriptions()){closeDialog();notify('Cloud cancellation is still pending. Keep this library and reset after confirmation.');return;}localFiles.clear();clearStoredAudio();
    clearAudio();state.recordings.forEach(r=>{if(r.audioUrl?.startsWith('blob:'))URL.revokeObjectURL(r.audioUrl);});
    state.recordings=clone(state.seed);state.projects=[];state.knownSpeakers=[];state.processing={};state.search='';state.libraryScroll=0;state.collapsedBatches.clear();persist();closeDialog();navigate();notify('Library cleared.');return;
  }
  if(action==='confirm-remove'){openDialog({type:'confirm-remove',recordingId:rec.id});return;}
  if(action==='remove-recording'){
    if(!await cancelTranscription(rec)){closeDialog();notify('Cloud cancellation is still pending. Remove this recording after confirmation.');return;}rememberUndo('Recording removed',rec.id);localFiles.delete(rec.id);delete state.processing[rec.id];if(state.audioId===rec.id)clearAudio();state.recordings=state.recordings.filter(r=>r.id!==rec.id);persist();closeDialog();navigate();notify('Recording removed from the demo.','undo');return;
  }
  if(action==='undo'&&state.undo){restoreUndo();return;}
});
document.addEventListener('input',event=>{
  if(event.target.id==='library-search'){state.search=event.target.value;refreshList();}
  if(event.target.id==='transcript-search'){
    const rec=currentRec();state.transcriptSearch=event.target.value;state.searchIndex=0;
    $('#transcript-turns').innerHTML=transcriptParagraphsMarkup(rec);updatePlayers();syncSearch(true);
  }
  if(event.target.matches('[data-seek]'))seekTo(recordById(event.target.dataset.seek),Number(event.target.value),false);
});
document.addEventListener('change',event=>{
  if(event.target.matches('[data-seek]')){const rec=recordById(event.target.dataset.seek);if(rec&&route().id===rec.id&&state.detailTab==='transcript')followPlayback(rec);}
  if(event.target.matches('[data-speed]')){state.rate=Number(event.target.value);audio.playbackRate=state.rate;$$('[data-speed]').forEach(select=>select.value=state.rate);}
  if(event.target.matches('[data-note-action]')){
    const rec=recordById(event.target.dataset.id),i=Number(event.target.dataset.noteAction),entry=rec.notes.actions[i];
    if(typeof entry==='string')rec.notes.actions[i]={text:entry,done:event.target.checked};else entry.done=event.target.checked;persist();
  }
});
document.addEventListener('submit',event=>{
  if(event.target.id==='ask-form'){event.preventDefault();const rec=currentRec(),query=new FormData(event.target).get('question')?.trim();if(query)askQuestion(rec,query);return;}
  if(event.target.id==='speaker-form'){
    event.preventDefault();const data=new FormData(event.target),name=String(data.get('name')||'').trim(),d=state.dialog,rec=recordById(d.recordingId);
    if(!name){$('#speaker-error').textContent='Enter a name before saving.';return;}
    rememberUndo('Speaker updated',rec.id);
    const speaker=speakerById(rec,d.speakerId);
    if(data.get('scope')==='segment'&&d.segmentId){
      const ids=d.segmentIds || [d.segmentId];let assigned=rec.speakers.find(s=>displayName(s).toLowerCase()===name.toLowerCase());
      if(!assigned){assigned={id:'speaker-'+uid(),name,confirmed:true};rec.speakers.push(assigned);}
      rec.segments.filter(s=>ids.includes(s.id)).forEach(s=>{s.speakerId=assigned.id;});
    }else if(speaker.id === 'unassigned'){
      let assigned=rec.speakers.find(s=>s.id !== 'unassigned' && displayName(s).toLowerCase()===name.toLowerCase());
      if(!assigned){assigned={id:'speaker-'+uid(),name,confirmed:true};rec.speakers.push(assigned);}
      rec.segments.filter(s=>s.speakerId === 'unassigned').forEach(s=>s.speakerId=assigned.id);
    }else{speaker.name=name;speaker.confirmed=true;delete speaker.suggestedName;}
    if(data.get('saveName')&&!state.knownSpeakers.some(s=>s.name.toLowerCase()===name.toLowerCase()))state.knownSpeakers.push({id:uid(),name});
    rec.notesStale=true;state.answer=null;persist();closeDialog();render();notify('Speaker updated in this recording.','undo');return;
  }
  if(event.target.id==='project-form'){
    event.preventDefault();const name=String(new FormData(event.target).get('name')||'').trim(),d=state.dialog;if(!name)return;
    const existing=projectById(d.projectId);
    if(existing){existing.name=name;persist();closeDialog();render();notify('Project renamed.');return;}
    const project={id:'project-'+uid(),name,createdAt:new Date().toISOString()};
    state.projects.push(project);
    const rec=recordById(d.recordingId);if(rec)rec.projectId=project.id;
    persist();closeDialog();
    if(rec){render();notify('Moved to '+project.name+'.');}
    else location.hash='#/project/'+encodeURIComponent(project.id);
    return;
  }
  if(event.target.id==='rename-form'){
    event.preventDefault();const title=String(new FormData(event.target).get('title')||'').trim(),rec=recordById(state.dialog.recordingId);if(!title)return;
    rememberUndo('Title updated',rec.id);rec.title=title;persist();closeDialog();render();notify('Recording renamed.','undo');return;
  }
});
document.addEventListener('keydown',event=>{
  if(event.target.closest?.('.transcript-paragraph.is-editing')){
    if(event.key==='Escape'){event.preventDefault();finishParagraphEdit(false);}
    else if(event.key==='Enter'&&!event.isComposing){event.preventDefault();finishParagraphEdit(true);}
    return;
  }
  if(event.target.id==='transcript-search'){
    if(event.key==='Enter'){event.preventDefault();state.searchIndex+=event.shiftKey?-1:1;syncSearch(true);}
    else if(event.key==='Escape'&&state.transcriptSearch){event.preventDefault();event.target.value='';event.target.dispatchEvent(new Event('input',{bubbles:true}));}
    return;
  }
  if(event.key==='Escape'&&event.target.id==='library-search'&&state.search){state.search='';render();}
  const input=event.target.closest('input,textarea,select,button,a,[contenteditable],dialog');
  if(!input&&!state.dialog&&event.key==='/'){event.preventDefault();($('#library-search')||$('#transcript-search'))?.focus();}
  if(!input&&!state.dialog&&event.code==='Space'&&route().view!=='upload'){const rec=currentRec();if(rec){event.preventDefault();state.follow=true;toggleAudio(rec);}}
  if(!input&&!state.dialog&&['ArrowLeft','ArrowRight'].includes(event.key)&&!event.metaKey&&!event.ctrlKey&&!event.altKey&&route().view==='detail'){const rec=currentRec();if(rec?.audioUrl&&state.audioId===rec.id){event.preventDefault();seekTo(rec,audio.currentTime+(event.key==='ArrowLeft'?-5:5),false);}}
  if(!input&&['PageUp','PageDown','Home','End','ArrowUp','ArrowDown'].includes(event.key))pauseFollowing();
});
window.addEventListener('wheel',pauseFollowing,{passive:true});
window.addEventListener('touchmove',pauseFollowing,{passive:true});
document.addEventListener('dragenter',event=>{if(event.dataTransfer?.types.includes('Files')){event.preventDefault();state.dragDepth++;document.body.classList.add('drag-over');}});
document.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault();});
document.addEventListener('dragleave',()=>{state.dragDepth=Math.max(0,state.dragDepth-1);if(!state.dragDepth)document.body.classList.remove('drag-over');});
document.addEventListener('drop',event=>{
  if(!event.dataTransfer?.files.length)return;event.preventDefault();state.dragDepth=0;document.body.classList.remove('drag-over');
  const mode=transcriptionMode();
  if(mode.engine==='deepgram' && !mode.configured){notify(mode.configurationError);return;}
  const files=[...event.dataTransfer.files].filter(f=>f.type.startsWith('audio/')||f.type.startsWith('video/')||/\.(m4a|mp3|wav|aac|aiff?|ogg|flac|mp4|mov|webm)$/i.test(f.name));
  if(!files.length){notify('Drop audio or video files to add a recording.');return;}
  receiveFiles(files);
});
window.addEventListener('scroll',()=>{if(state.lastView==='library'&&route().view==='library')state.libraryScroll=window.scrollY;},{passive:true});
window.addEventListener('hashchange',()=>{const next=route();state.transcriptSearch='';state.detailTab='transcript';state.answer=null;render();window.scrollTo({top:next.view==='library'?state.libraryScroll:0,behavior:'instant'});});
init();
