import '@phosphor-icons/web/regular';
import './styles.css';
import { exportRecording } from './export-client.js';
import { transcribeFile, resumeTranscription, cancelTranscriptionJob, getTranscriptionMode } from './transcription-client.js';

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
const formatSize = bytes => bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
const dateLabel = value => new Intl.DateTimeFormat('en-US', {month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit'}).format(new Date(value));
const button = (name, label, action, extras = '', cls = '') => `<button type="button" class="icon-button ${cls}" aria-label="${esc(label)}" data-tooltip="${esc(label)}" data-action="${action}" ${extras}>${icon(name)}</button>`;
const root = $('#root');
root.setAttribute('aria-live', 'off');
const audio = document.createElement('audio');
audio.preload = 'metadata';
audio.id = 'demo-audio';
document.body.append(audio);
const state = {
  recordings: [], seed: [], knownSpeakers: [], expandedId: null, search: '', showSearch: false,
  detailTab: 'transcript', sideTab: 'notes', transcriptSearch: '', audioId: null, currentTime: 0,
  playing: false, rate: 1, dialog: null, answer: null, messages: {}, collapsedBatches: new Set(),
  undo: null, loading: true, dragDepth: 0, pendingFiles: [], pendingSeek: null, processing: {},
  libraryScroll: 0, lastView: 'upload', seedSignature: '', exportingFormat: null
};
const localFiles = new Map();
const transcriptionQueue = [];
const transcriptionJobs = new Map();
let activeTranscription = null;
const activeStages = new Set(['queued','uploading','model-loading','decoding','transcribing','aligning','diarizing','cancelling']);
const icons = {ready:'check-circle', partial:'users', 'needs-audio':'link-break', queued:'clock', uploading:'upload-simple', 'model-loading':'circle-notch', decoding:'waveform', transcribing:'waveform', aligning:'crosshair', diarizing:'users', interrupted:'arrow-clockwise', cancelling:'circle-notch', 'cancellation-unconfirmed':'warning-circle', cancelled:'pause-circle', error:'warning-circle'};
function transcriptionMode() { return getTranscriptionMode(); }
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
function speakerManagerLabel(rec) { return hasUnassignedSegments(rec) ? 'Assign speakers' : new Set(rec.segments.map(s=>s.speakerId)).size + ' speakers'; }
function route() {
  const match = location.hash.match(/^#\/recording\/(.+)$/);
  let id = null;
  try { id = match ? decodeURIComponent(match[1]) : null; } catch {}
  if (id && recordById(id)) return {view:'detail', id};
  if (location.hash === '#/library' || match) return {view:'library'};
  return {view:'upload'};
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
          copy.transcription={...copy.transcription,status:'interrupted',stage:'interrupted',error:'Transcription stopped when this page was closed or refreshed.'};
        }
      } else delete copy.audioUrl;
      if(copy.transcription)delete copy.transcription.cancelRequestInFlight;
      delete copy.processing;
      return copy;
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify({recordings, knownSpeakers:state.knownSpeakers, seedSignature:state.seedSignature}));
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
  root.innerHTML = '<main class="shell loading-screen" aria-label="Loading demo"><span class="loading-ring"></span><span>Opening samples…</span></main>';
  try {
    const payload = window.__DEMO_RECORDINGS__ || await fetch('./samples/sample-recordings.json').then(r => { if (!r.ok) throw new Error('Samples could not be loaded'); return r.json(); });
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
    state.expandedId = state.recordings.find(r => r.segments.length)?.id || null;
    state.loading = false;
    if (!location.hash || location.hash === '#/') history.replaceState(null,'',location.pathname + location.search + '#/upload');
    persist();
    render();
    state.recordings.filter(rec=>rec.source==='local-upload' && !rec.segments.length && rec.transcription?.job?.accessToken && !['error','cancelled'].includes(rec.status)).forEach(rec=>queueTranscription(rec,null,{resumeJob:rec.transcription.job}));
  } catch (error) {
    state.loading = false;
    render();
    notify('Sample files are unavailable. You can still add your own audio.');
  }
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
function fileSourceLabel(rec) { const label=sourceLabel(rec);return isAsrDraft(rec) && !label.toLowerCase().includes('draft') ? label+' · ASR draft' : label; }
function status(rec) {
  if (state.processing[rec.id]) {
    const current=state.processing[rec.id];
    if(['cancelling','cancellation-unconfirmed'].includes(current.key))return {...current,detail:current.key==='cancelling'?'Waiting for service confirmation':'Retry cancellation or check status'};
    return {...current,detail:progressLabel(current) || current.detail};
  }
  if (rec.transcription?.job?.accessToken && rec.transcription.cancelRequestedAt) return {key:rec.transcription.cancellationError?'cancellation-unconfirmed':'cancelling',label:rec.transcription.cancellationError?'Cancellation not confirmed':'Cancelling',detail:rec.transcription.cancellationError?'Retry cancellation or check status':'Waiting for WhisperX to stop'};
  if (rec.status === 'error') return {key:'error',label:'Transcription failed',detail:'Open to retry'};
  if (rec.status === 'cancelled') return {key:'cancelled',label:'Transcription cancelled',detail:'Open to resume'};
  if (rec.status === 'interrupted' || !rec.segments.length) return {key:'interrupted',label:'Transcription paused',detail:'Choose the audio to resume'};
  if (hasUnassignedSegments(rec)) return {key:'partial',label:'Transcript ready',detail:'Speakers unassigned'};
  return {key:'ready',label:'Transcript ready',detail:rec.source === 'local-upload' ? rec.segments.length+' segments' : ''};
}
function statusMarkup(rec) {
  const current=status(rec);
  return `<span class="record-status state-${esc(current.key)} ${current.key==='ready'?'ready-label':''}" data-recording-status="${esc(rec.id)}" data-status-key="${esc(current.key)}"><span class="status-top">${icon(icons[current.key] || 'info')}<span>${esc(current.label)}</span></span>${current.detail ? '<span class="status-detail">'+esc(current.detail)+'</span>':''}</span>`;
}
function toolbar(mode = 'library') {
  const detail = mode === 'detail';
  return `<header class="toolbar ${detail ? 'detail-toolbar' : ''}">
    <div class="toolbar-left">${detail ? button('arrow-left','Back to library','back') : mode === 'upload' ? `<div class="page-context">${icon('waveform')}<span>Upload</span></div>` : button('arrow-left','Back to upload','go-upload') + (state.showSearch || state.search ? `<div class="search-field">${icon('magnifying-glass')}<input id="library-search" type="search" autocomplete="off" placeholder="Search recordings" value="${esc(state.search)}" aria-label="Search recordings">${button('x','Close search','close-search','','small')}</div>` : button('magnifying-glass','Search recordings','search'))}</div>
    <div class="toolbar-actions">${detail ? button('download-simple','Export transcript','export','data-id="' + esc(currentRec()?.id) + '"') : ''}
    ${mode === 'upload' ? button('stack','Open library','go-library') : ''}${button('info','About this demo','info')}${mode === 'upload' ? '' : button('upload-simple','Add recordings','go-upload','','primary')}</div>
  </header>`;
}
function player(rec, compact = false) {
  const active = state.audioId === rec.id;
  const time = active ? audio.currentTime || 0 : 0;
  return `<div class="player ${compact ? 'compact-player' : ''}" data-player="${esc(rec.id)}">
    ${button(active && state.playing ? 'pause' : 'play', active && state.playing ? 'Pause audio' : 'Play audio','play','data-id="' + esc(rec.id) + '"','play-control')}
    <div class="player-track"><input type="range" min="0" max="${Math.max(rec.duration,1)}" step="0.01" value="${time}" class="seek" aria-label="Seek audio" data-seek="${esc(rec.id)}" style="--progress:${rec.duration ? time / rec.duration * 100 : 0}%"></div>
    <span class="player-time" data-time="${esc(rec.id)}">${formatTime(time)} / ${formatTime(rec.duration)}</span>
    <label class="speed-select"><span class="sr-only">Playback speed</span><select data-speed="${esc(rec.id)}" aria-label="Playback speed">${[0.75,1,1.25,1.5,2].map(n => `<option value="${n}" ${state.rate === n ? 'selected' : ''}>${n}×</option>`).join('')}</select>${icon('caret-down')}</label>
  </div>`;
}
function segmentMarkup(rec, segment, preview = false) {
  const speaker = speakerById(rec, segment.speakerId);
  const active = state.audioId === rec.id && segment.start !== null && audio.currentTime >= segment.start && audio.currentTime < (segment.end ?? Infinity);
  return `<article class="transcript-turn ${active ? 'is-current' : ''}" id="segment-${esc(segment.id)}" data-segment="${esc(segment.id)}" data-recording="${esc(rec.id)}">
    <button type="button" class="timecode" data-action="seek-segment" data-id="${esc(rec.id)}" data-segment-id="${esc(segment.id)}" ${segment.start === null ? 'disabled title="No timestamp in this imported text"' : 'aria-label="Play from ' + formatTime(segment.start) + '"'}>${formatTime(segment.start)}</button>
    <div class="turn-content"><button type="button" class="speaker-label" data-action="speaker" data-id="${esc(rec.id)}" data-speaker-id="${esc(speaker.id)}" data-segment-id="${esc(segment.id)}">${esc(displayName(speaker))}${icon('caret-down')}${speaker.confirmed === false && speaker.id !== 'unassigned' ? '<span class="unconfirmed">Unconfirmed</span>' : ''}</button>
    <p>${esc(segment.text)}</p></div>
    ${preview ? '' : button('dots-three','Edit this transcript segment','segment-menu','data-id="' + esc(rec.id) + '" data-segment-id="' + esc(segment.id) + '"','turn-menu')}
  </article>`;
}
function recordingModule(rec) {
  const expanded = state.expandedId === rec.id;
  return `<article class="recording-module ${expanded ? 'is-expanded' : ''}" data-recording-card="${esc(rec.id)}" aria-label="${esc(rec.title)} recording">
    <div class="recording-header"><a href="#/recording/${encodeURIComponent(rec.id)}" class="recording-main" aria-label="Open ${esc(rec.title)}">
      <div class="record-identity"><h2>${esc(rec.title)}</h2><div class="file-meta">${esc(rec.originalFilename)}<span aria-hidden="true"> · </span><span>${esc(fileSourceLabel(rec))}</span></div></div>
      <span class="record-duration">${formatTime(rec.duration)}</span>${statusMarkup(rec)}</a>
      ${button(expanded ? 'caret-up' : 'caret-right',expanded ? 'Collapse recording preview' : 'Preview recording','preview','data-id="' + esc(rec.id) + '"','preview-toggle')}
    </div>
    ${expanded ? `<div class="recording-preview">${player(rec,true)}
      ${state.processing[rec.id] ? processingMarkup(rec) : rec.segments.length ? '<div class="preview-transcript">' + rec.segments.slice(0,2).map(s => segmentMarkup(rec,s,true)).join('') + '</div>' : missingTranscript(rec,true)}
      <div class="preview-footer">${button('arrows-out-simple','Open full recording','open','data-id="' + esc(rec.id) + '"','open-detail')}</div></div>` : ''}
  </article>`;
}
function libraryList() {
  const query = state.search.toLowerCase().trim();
  const filtered = state.recordings.filter(r => [r.title, r.originalFilename, ...r.speakers.map(displayName)].some(v => v.toLowerCase().includes(query)));
  if (!filtered.length) return `<div class="empty-state">${icon(state.search ? 'magnifying-glass' : 'waveform')}<h2>${state.search ? 'No recordings found' : 'Your first recording starts here'}</h2><p>${state.search ? 'Try another file name or speaker.' : 'Add audio or video, or restore the sample library.'}</p>${state.search ? '<button class="text-button" data-action="clear-search">Clear search</button>' : '<button class="button primary" data-action="upload">Add audio</button>'}</div>`;
  const groups = new Map();
  filtered.forEach(r => { if (!groups.has(r.batchId)) groups.set(r.batchId, []); groups.get(r.batchId).push(r); });
  return [...groups.entries()].map(([id, recs]) => `<section class="batch" aria-label="Uploaded ${esc(dateLabel(recs[0].uploadedAt))}">
    <button type="button" class="batch-header" data-action="batch" data-batch-id="${esc(id)}" aria-expanded="${!state.collapsedBatches.has(id)}">${icon('upload-simple')}<span>${esc(dateLabel(recs[0].uploadedAt))}</span><span class="batch-caret">${icon(state.collapsedBatches.has(id) ? 'caret-right' : 'caret-down')}</span>${state.collapsedBatches.has(id) ? '<span class="batch-count">' + recs.length + ' files</span>' : ''}</button>
    ${!state.collapsedBatches.has(id) ? '<div class="batch-list">' + recs.map(recordingModule).join('') + '</div>' : ''}
  </section>`).join('');
}
function renderLibrary() {
  return `<main class="shell library-shell"><h1 class="sr-only">Library</h1>${toolbar()}<div class="library-context"><span>Library</span><span>${state.recordings.length} recording${state.recordings.length === 1 ? '' : 's'}</span></div><div id="recording-list">${libraryList()}</div><footer class="library-footer"><span>Interactive demo</span><span class="footer-dot">·</span><button type="button" class="quiet-link" data-action="info">About the recordings and local playback</button></footer></main>`;
}
function renderUpload() {
  return `<main class="shell upload-shell">${toolbar('upload')}
    <section class="upload-entry" aria-labelledby="upload-title">
      <div class="entry-heading"><h1 id="upload-title">Add audio or video</h1><p>Choose recordings. Your transcript will be created automatically.</p></div>
      ${transcriptionMode().configured===false ? '<div class="service-notice" role="status">'+icon('plug')+'<span><strong>Transcription is unavailable</strong><br>WhisperX service is not connected yet.</span></div>' : ''}
      <div class="upload-dropzone" id="upload-dropzone">
        <div class="upload-symbol">${icon('upload-simple')}</div>
        <h2>Drop your files here</h2>
        <p>One conversation, or a whole batch.</p>
        <button type="button" class="button primary upload-choice" data-action="choose-upload">${icon('plus')}Choose audio or video</button>
        <div class="upload-formats"><span>${icon('file-audio')}Audio</span><span>${icon('video')}Video</span><span class="formats-detail">MP3, M4A, WAV, MP4, MOV and more</span></div>
      </div>
      <div class="upload-next"><button type="button" class="text-button sample-library-link" data-action="go-library">View sample library${icon('arrow-up-right')}</button><span>Listen to a recording and explore its transcript.</span></div>
      <p class="upload-privacy">${icon('lock-key')}${transcriptionMode().location === 'server' ? 'Audio is sent to the WhisperX service to create your transcript.' : 'Transcription runs on this device. Your audio stays in your browser.'}</p>
    </section>
  </main>`;
}

function missingTranscript(rec, compact = false) {
  if(rec.transcription?.job?.accessToken && rec.transcription.cancelRequestedAt)return processingMarkup(rec);
  const current=status(rec), needsFile=!rec.transcription?.job?.accessToken && (rec.needsAudio || !localFiles.has(rec.id));
  const failed=rec.status==='error';
  const heading=failed ? 'Transcription could not finish' : rec.status==='cancelled' ? 'Transcription cancelled' : 'Resume transcription';
  const message=failed ? rec.transcription?.error || 'Please retry this recording or choose another audio format.' : needsFile ? 'Choose the original audio once to continue. A transcript file is not needed.' : 'Your audio is still available. Resume when you are ready.';
  return `<div class="missing-transcript ${compact?'is-compact':''}">${icon(failed?'warning-circle':needsFile?'link':'arrow-clockwise')}<div><h3>${heading}</h3><p>${esc(message)}</p><button type="button" class="button ${failed?'primary':'secondary'}" data-action="${needsFile?'reconnect':'retry-transcription'}" data-id="${esc(rec.id)}">${icon(needsFile?'file-audio':'arrow-clockwise')}${needsFile?'Choose original audio':'Retry transcription'}</button></div></div>`;
}
function processingVisual(rec) {
  const current=state.processing[rec.id] || status(rec);
  if(['cancelling','cancellation-unconfirmed'].includes(current.key)) return `<div class="processing-heading">${current.key==='cancelling'?'<span class="loading-ring" aria-hidden="true"></span>':icon('warning-circle')}<h3 aria-live="polite">${esc(current.label)}</h3></div><p class="processing-description">${esc(rec.transcription.cancellationError || current.detail || 'Waiting for the service to confirm that processing has stopped.')}</p><p class="fine-print">The cloud job may still be running until cancellation is confirmed.</p>`;
  const known=Number.isFinite(current.percent), percent=known?Math.max(0,Math.min(100,current.percent)):null;
  const preparing=['uploading','model-loading','decoding'].includes(current.key);
  const phase=current.key==='queued'?0:preparing?1:2;
  const phases=['Queued','Prepare audio','Transcribe','Ready'];
  return `<div class="processing-heading"><span class="loading-ring" aria-hidden="true"></span><h3 aria-live="polite">${esc(current.label)}</h3></div><p class="processing-description">${esc(current.detail || 'Your recording will appear here as soon as transcription finishes.')}</p><div class="job-progress ${known?'':'is-indeterminate'}" role="progressbar" aria-label="${esc(current.label)}" ${known?'aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+Math.round(percent)+'"':''}><span style="${known?'width:'+percent+'%':''}"></span></div><div class="job-progress-meta"><span>${esc(progressLabel(current) || (current.key==='queued'?'Waiting for a processing slot':'Processing your recording'))}</span><span>${known?'This step':''}</span></div><ol class="process-steps">${phases.map((label,index)=>`<li class="${index<phase?'complete':index===phase?'active':''}"><span>${index<phase?icon('check'):index+1}</span>${label}</li>`).join('')}</ol>`;
}
function processingMarkup(rec) {
  return `<div class="processing-panel" data-processing-view="${esc(rec.id)}"><div class="processing-visual">${processingVisual(rec)}</div><div class="processing-actions">${cancellationActions(rec)}</div><p class="fine-print" data-job-retention>${cancellationRetention(rec)}</p></div>`;
}
function cancellationActions(rec) {
  const waiting=Boolean(rec.transcription?.cancelRequestedAt && rec.transcription?.job?.accessToken),requesting=Boolean(rec.transcription?.cancelRequestInFlight);
  return `<button type="button" class="quiet-link" data-action="cancel-transcription" data-id="${esc(rec.id)}" ${requesting?'disabled':''}>${icon(requesting?'circle-notch':'x')}${requesting?'Requesting cancellation':waiting?'Retry cancellation':'Cancel transcription'}</button>${waiting?`<button type="button" class="quiet-link" data-action="retry-transcription" data-id="${esc(rec.id)}">${icon('arrow-clockwise')}Check status</button>`:''}`;
}
function cancellationRetention(rec) {
  return rec.transcription?.job?.accessToken?'You can switch views or refresh. This cloud job will reconnect automatically.':'You can leave this view. Keep this page open until the audio finishes uploading.';
}
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
  return `<div class="ask-content">${rec.notesStale ? '<div class="notice">' + icon('info') + '<span>The transcript changed. Prepared answers are hidden; search now uses your current text.</span></div>' : ''}<div class="panel-kicker">${rec.notesStale || !rec.qa.length ? 'Transcript search · with sources' : 'Prepared answers · with sources'}</div><p class="ask-intro">Explore what was said.</p>
    <div class="question-suggestions">${questions.map((q,i) => `<button type="button" class="suggestion-button" data-action="ask-suggested" data-id="${esc(rec.id)}" data-question-index="${i}">${esc(q.question)}${icon('arrow-up-right')}</button>`).join('')}</div>
    ${answer ? `<div class="qa-answer"><div class="question-label">${esc(answer.question)}</div><p>${esc(answer.answer)}</p><div class="answer-citations">${(answer.citationSegmentIds || []).map(id => citationButton(rec,id)).join('')}</div>${answer.excerpt ? '<span class="panel-kicker">Transcript excerpt</span><blockquote>' + esc(answer.excerpt) + '</blockquote>' : ''}</div>` : ''}
    <form class="ask-form" id="ask-form"><label class="sr-only" for="question-input">Ask about this recording</label><input id="question-input" name="question" placeholder="Ask about this recording…" autocomplete="off" required><button type="submit" class="icon-button primary" aria-label="Ask question" data-tooltip="Ask question">${icon('arrow-up')}</button></form>
    <p class="fine-print">Suggested questions use prepared, source-linked answers. Other questions search this transcript for relevant passages.</p></div>`;
}
function transcriptMarkup(rec) {
  if (state.processing[rec.id]) return processingMarkup(rec);
  if (!rec.segments.length || rec.needsAudio && !rec.segments.length) return missingTranscript(rec);
  const q = state.transcriptSearch.toLowerCase();
  const segments = rec.segments.filter(s => !q || (s.text + ' ' + displayName(speakerById(rec,s.speakerId))).toLowerCase().includes(q));
  return `<div class="transcript-tools"><div class="transcript-search">${icon('magnifying-glass')}<input id="transcript-search" type="search" placeholder="Find in transcript" aria-label="Find in transcript" value="${esc(state.transcriptSearch)}"></div><button class="quiet-link follow-playback" aria-label="Go to current playback moment" data-action="follow" data-id="${esc(rec.id)}">${icon('crosshair')}<span>Current moment</span></button></div>
    <div class="transcript-reading" id="transcript-turns">${segments.length ? segments.map(s => segmentMarkup(rec,s)).join('') : '<div class="panel-empty"><p>No matching passages.</p></div>'}</div>`;
}
function renderDetail(rec) {
  const statusText = status(rec);
  return `<main class="shell detail-shell"><h1 class="sr-only">${esc(rec.title)} transcript</h1>${toolbar('detail')}
    <section class="recording-workspace">
      <header class="detail-heading"><div><div class="detail-title-row"><button class="editable-title" data-action="rename-recording" data-id="${esc(rec.id)}" aria-label="Rename recording: ${esc(rec.title)}">${esc(rec.title)}${icon('pencil-simple')}</button><span class="sample-label">${esc(fileSourceLabel(rec))}</span></div><div class="detail-meta"><span>${esc(rec.originalFilename)}</span><span>${formatTime(rec.duration)}</span><span>${icon('upload-simple')}${esc(dateLabel(rec.uploadedAt))}</span></div></div>
      <div class="detail-heading-actions">${statusMarkup(rec)}${button('dots-three','Recording actions','recording-menu','data-id="' + esc(rec.id) + '"')}</div></header>
      <div class="detail-mobile-status state-${esc(statusText.key)}" data-mobile-status="${esc(rec.id)}">${icon(icons[statusText.key] || 'info')}<span>${esc(statusText.label)}${statusText.detail?' · '+esc(statusText.detail):''}</span></div>
      <div class="detail-player-wrap">${player(rec)}</div>
      <nav class="workspace-tabs" aria-label="Recording workspace"><div class="main-tabs" role="tablist">${[{id:'transcript',icon:'text-align-left',label:'Transcript'},{id:'notes',icon:'note-pencil',label:'Notes'},{id:'ask',icon:'chat-circle-text',label:'Ask'}].map(t => `<button id="tab-${t.id}" type="button" role="tab" aria-selected="${state.detailTab === t.id}" aria-controls="workspace-panel" class="workspace-tab ${state.detailTab === t.id ? 'active' : ''}" data-action="tab" data-tab="${t.id}">${icon(t.icon)}${t.label}</button>`).join('')}</div>
      ${rec.segments.length ? '<button type="button" class="quiet-link speaker-manager" aria-label="' + esc(speakerManagerLabel(rec)) + '" data-action="manage-speakers" data-id="' + esc(rec.id) + '">' + icon('users') + '<span>' + speakerManagerLabel(rec) + '</span></button>' : ''}</nav>
      <div class="workspace-body ${state.detailTab === 'transcript' ? 'split-workspace' : ''}" id="workspace-panel" role="tabpanel" aria-labelledby="tab-${state.detailTab}">
      ${state.detailTab === 'transcript' ? '<section class="transcript-panel" aria-label="Transcript">' + transcriptMarkup(rec) + '</section><aside class="insight-panel"><div class="insight-tabs"><button class="' + (state.sideTab === 'notes' ? 'active' : '') + '" data-action="side-tab" data-tab="notes">' + icon('note-pencil') + 'Notes</button><button class="' + (state.sideTab === 'ask' ? 'active' : '') + '" data-action="side-tab" data-tab="ask">' + icon('chat-circle-text') + 'Ask</button></div>' + (state.sideTab === 'notes' ? notesMarkup(rec) : qaMarkup(rec)) + '</aside>' : '<section class="wide-panel">' + (state.detailTab === 'notes' ? notesMarkup(rec) : qaMarkup(rec)) + '</section>'}
      </div>
    </section>
    <footer class="detail-footer"><span>${rec.source === 'synthetic-demo' ? 'Synthetic speech · authored transcript' : rec.source === 'local-upload' ? rec.needsAudio && rec.segments.length ? 'Transcript saved · reconnect audio for playback' : rec.segments.length ? 'Automatic transcript · review against the audio' : 'Audio selected · automatic transcription' : isAsrDraft(rec) ? 'Unreviewed ASR draft · check the audio when accuracy matters' : 'Sample recording · timestamped transcript'}</span><button class="quiet-link" data-action="info">About this demo</button></footer>
  </main>`;
}
function render() {
  const pos = window.scrollY;
  const active = route();
  root.innerHTML = active.view === 'detail' ? renderDetail(recordById(active.id)) : active.view === 'library' ? renderLibrary() : renderUpload();
  state.lastView = active.view;
  if (state.dialog && !$('#demo-dialog')) renderDialog();
  updatePlayers();
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
  $$('[data-segment]').forEach(el => {
    const rec = recordById(el.dataset.recording);
    const segment = rec?.segments.find(s => s.id === el.dataset.segment);
    const current = state.audioId === rec?.id && segment?.start !== null && audio.currentTime >= segment?.start && audio.currentTime < (segment?.end ?? Infinity);
    el.classList.toggle('is-current',Boolean(current));
    if (current) el.setAttribute('aria-current','true'); else el.removeAttribute('aria-current');
  });
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

function openDialog(config) { state.dialog = config; renderDialog(); }
function closeDialog() {
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
    dialog = document.createElement('dialog'); dialog.id='demo-dialog'; dialog.className='demo-dialog'; dialog.setAttribute('aria-labelledby','dialog-title');
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
    dialog.addEventListener('click', event => { if (event.target === dialog) { const b=dialog.getBoundingClientRect(); if (event.clientX<b.left || event.clientX>b.right || event.clientY<b.top || event.clientY>b.bottom) closeDialog(); } });
    document.body.append(dialog);
  }
  const d=state.dialog, rec=recordById(d.recordingId);
  let content = '';
  if (d.type === 'info') {
    const sample=currentRec() || state.seed.find(r=>r.source === 'user-recording');
    const provenance=sample?.provenance;
    const excerpt=sample ? excerptInfo(sample) : null;
    const excerptDescription=excerpt ? (excerpt.start===0 ? 'First '+Math.round(excerpt.duration)+' seconds of '+formatTime(excerpt.original)+' source recording.' : formatTime(excerpt.start)+'–'+formatTime(excerpt.end)+' excerpt of '+formatTime(excerpt.original)+' source recording.') : '';
    const sourceInfo=sample && isAsrDraft(sample) ? `<div class="notice source-notice">${icon('info')}<span><strong>${esc(sample.title)} · ASR draft</strong><br>${excerptDescription ? esc(excerptDescription)+'<br>' : ''}Uncorrected text with approximate segment timestamps. ${hasUnassignedSegments(sample) ? 'Speakers have not been separated; Unknown speaker is an unassigned bucket.' : 'Speaker names have been manually assigned.'}</span></div>${provenance ? '<details class="source-details"><summary>How this recording was prepared</summary><p>' + esc(provenance.transcript || '') + '</p><p>' + esc(provenance.timestamps || '') + '</p><p>' + esc(provenance.notesAndQa || '') + '</p></details>' : ''}` : '';
    content=dialogFrame('About Duowen',`<p class="dialog-lead">Listen, find the moment, and make the transcript yours.</p>${sourceInfo}<div class="info-feature">${icon('waveform')}<div><h3>A sample library to explore</h3><p>Bundled recordings include timestamped transcripts, prepared notes and source-linked answers.</p></div></div><div class="info-feature">${icon('lock-key')}<div><h3>Audio & privacy</h3><p>${transcriptionMode().location==='server'?'Audio is sent to the connected WhisperX service for transcription.':'Transcription runs on this device. Your audio is not uploaded.'} Your transcript and edits are saved in this browser.</p></div></div><div class="info-feature">${icon('sparkle')}<div><h3>Automatic, with clear feedback</h3><p>New recordings are transcribed automatically. Processing states reflect the actual job. Speaker separation is shown only when the service returns it; saved names do not perform voice matching.</p></div></div><p class="fine-print">Edits are saved in this browser. Local audio files need reconnecting after a refresh.</p>`,
      '<button class="quiet-link" data-action="confirm-reset">' + icon('arrow-counter-clockwise') + 'Reset demo</button><button class="button primary" data-action="close-dialog">Explore</button>');
  } else if (d.type === 'upload') {
    content=dialogFrame('Add recordings',`<div class="upload-files">${state.pendingFiles.map((file,i) => `<div class="upload-file">${icon(file.type.startsWith('video/')?'video':'file-audio')}<div><strong>${esc(file.name)}</strong><span>${formatSize(file.size)}</span></div>${button('x','Remove ' + file.name,'remove-pending','data-index="' + i + '"','small')}</div>`).join('')}</div><div class="inline-note">${icon('waveform')}<span>${transcriptionMode().configured===false ? 'WhisperX service is not connected. Transcription cannot start yet.' : 'Transcription starts automatically. Track each recording in your library.'}</span></div>`,
      '<button class="button secondary" data-action="add-more-files">Add more</button><button class="button primary" data-action="confirm-upload" ' + (!state.pendingFiles.length || transcriptionMode().configured===false ? 'disabled' : '') + '>Transcribe ' + state.pendingFiles.length + ' recording' + (state.pendingFiles.length!==1?'s':'') + '</button>');
  } else if (d.type === 'speaker') {
    const speaker=speakerById(rec,d.speakerId);
    content=dialogFrame('Edit speaker',`<form id="speaker-form"><label class="field-label" for="speaker-name">Display name</label><input class="text-input" id="speaker-name" name="name" required maxlength="100" value="${esc(displayName(speaker))}" autocomplete="off">
      ${speaker.suggestedName && speaker.confirmed===false ? `<div class="suggested-person"><span class="panel-kicker">Sample suggestion · not voice recognition</span><strong>${esc(speaker.suggestedName)}</strong><div><button type="button" class="text-button" data-action="use-suggested" data-name="${esc(speaker.suggestedName)}">Use this name</button><button type="button" class="quiet-link" data-action="reject-suggested">Not this person</button></div></div>` : ''}
      ${state.knownSpeakers.length ? '<div class="saved-names"><span class="field-label">Choose a saved name</span><div>' + state.knownSpeakers.map(s => '<button type="button" class="name-choice" data-action="choose-name" data-name="' + esc(s.name) + '">' + icon('user') + esc(s.name) + '</button>').join('') + '</div></div>' : ''}
      <fieldset class="scope-options"><legend>Apply to</legend><label><input type="radio" name="scope" value="speaker" ${d.scope!=='segment'?'checked':''}><span>${speaker.id === 'unassigned' ? 'All currently unassigned segments' : 'This speaker throughout this recording'}</span></label>${d.segmentId ? '<label><input type="radio" name="scope" value="segment" ' + (d.scope==='segment'?'checked':'') + '><span>Only this transcript segment</span></label>' : ''}</fieldset>
      <label class="check-label"><input type="checkbox" name="saveName"><span>Save this name for other recordings</span></label><p class="fine-print">Saving a name does not identify or learn someone’s voice.</p><div class="form-error" id="speaker-error" role="alert"></div>
      <div class="dialog-footer inline-footer"><button type="button" class="button secondary" data-action="close-dialog">Cancel</button><button type="submit" class="button primary">Save name</button></div></form>`);
  } else if (d.type === 'speakers') {
    content=hasUnassignedSegments(rec) ? dialogFrame('Assign speakers',`<p class="dialog-lead">Automatic speaker separation has not run. Choose a passage to assign its speaker manually.</p><div class="speaker-list segment-assignment-list">${rec.segments.map(s=>`<button class="speaker-list-row" data-action="speaker" data-id="${esc(rec.id)}" data-speaker-id="${esc(s.speakerId)}" data-segment-id="${esc(s.id)}" data-scope="segment"><span class="assignment-time">${formatTime(s.start)}</span><span><strong>${esc(displayName(speakerById(rec,s.speakerId)))}</strong><small>${esc(s.text)}</small></span>${icon('pencil-simple')}</button>`).join('')}</div>`) : dialogFrame('Speakers',`<p class="dialog-lead">Names belong to this recording. Change one without changing other files.</p><div class="speaker-list">${rec.speakers.filter(s=>rec.segments.some(t=>t.speakerId === s.id)).map(s=>`<button class="speaker-list-row" data-action="speaker" data-id="${esc(rec.id)}" data-speaker-id="${esc(s.id)}"><span class="speaker-avatar">${icon('user')}</span><span><strong>${esc(displayName(s))}</strong><small>${rec.segments.filter(t=>t.speakerId===s.id).length} segments${s.confirmed===false?' · Unconfirmed':''}</small></span>${icon('pencil-simple')}</button>`).join('')}</div>`);
  } else if (d.type === 'segment-menu') {
    const segment=rec.segments.find(s=>s.id===d.segmentId);
    content=dialogFrame('This segment',`<div class="segment-excerpt"><span>${formatTime(segment.start)} · ${esc(displayName(speakerById(rec,segment.speakerId)))}</span><p>${esc(segment.text)}</p></div><div class="action-menu"><button data-action="edit-segment" data-id="${esc(rec.id)}" data-segment-id="${esc(segment.id)}">${icon('pencil-simple')}Edit text</button><button data-action="reassign-segment" data-id="${esc(rec.id)}" data-segment-id="${esc(segment.id)}">${icon('user-switch')}Change this segment’s speaker</button><button data-action="seek-segment" data-id="${esc(rec.id)}" data-segment-id="${esc(segment.id)}">${icon('play')}Play from this moment</button></div>`);
  } else if (d.type === 'edit-segment') {
    const segment=rec.segments.find(s=>s.id===d.segmentId);
    content=dialogFrame('Edit transcript text',`<form id="segment-form"><label class="field-label" for="segment-text">${formatTime(segment.start)} · ${esc(displayName(speakerById(rec,segment.speakerId)))}</label><textarea id="segment-text" name="text" rows="6" required>${esc(segment.text)}</textarea><p class="fine-print">Timing and speaker stay the same. Existing notes will be marked for review.</p><div class="form-error" role="alert" id="segment-error"></div><div class="dialog-footer inline-footer"><button type="button" class="button secondary" data-action="close-dialog">Cancel</button><button class="button primary" type="submit">Save text</button></div></form>`);
  } else if (d.type === 'rename') {
    content=dialogFrame('Rename recording',`<form id="rename-form"><label class="field-label" for="recording-title">Title</label><input id="recording-title" name="title" class="text-input" value="${esc(rec.title)}" maxlength="250" required><p class="fine-print">Original file: ${esc(rec.originalFilename)}</p><div class="dialog-footer inline-footer"><button type="button" class="button secondary" data-action="close-dialog">Cancel</button><button type="submit" class="button primary">Save title</button></div></form>`);
  } else if (d.type === 'recording-menu') {
    content=dialogFrame('Recording actions',`<div class="action-menu"><button data-action="rename-recording" data-id="${esc(rec.id)}">${icon('pencil-simple')}Rename</button><button data-action="import-transcript" data-id="${esc(rec.id)}" ${isTranscribing(rec)?'disabled':''}>${icon('file-text')}Import subtitle file (optional)</button><button data-action="reconnect" data-id="${esc(rec.id)}">${icon('link')}Reconnect audio</button><button data-action="export" data-id="${esc(rec.id)}">${icon('download-simple')}Export transcript</button><button class="danger-text" data-action="confirm-remove" data-id="${esc(rec.id)}">${icon('trash')}Remove from this library</button></div>`);
  } else if (d.type === 'export') {
    content=dialogFrame('Export transcript',`<p class="dialog-lead">Names and text include your latest changes.</p>${state.exportingFormat ? '<div class="export-progress" role="status">' + icon('circle-notch') + '<span>Preparing ' + esc(state.exportingFormat === 'docx' ? 'Word document' : state.exportingFormat.toUpperCase()) + '…</span></div>' : ''}<div class="export-options">${[{id:'pdf',label:'PDF',desc:'A clean, paginated transcript for reading or sharing',icon:'file-pdf'},{id:'docx',label:'Word (.docx)',desc:'An editable Word document with speakers and times',icon:'file-doc'},{id:'md',label:'Markdown',desc:'Structured text for your notes or knowledge base',icon:'file-md'},{id:'txt',label:'Plain text',desc:'Readable transcript with speakers and times',icon:'file-text'},{id:'srt',label:'SRT subtitles',desc:'Timestamped subtitles for video editors',icon:'subtitles'},{id:'vtt',label:'WebVTT',desc:'Timestamped captions for the web',icon:'closed-captioning'},{id:'json',label:'JSON',desc:'Segments, speakers, notes and file metadata',icon:'brackets-curly'}].map(o=>`<button data-action="download" data-format="${o.id}" data-id="${esc(rec.id)}" ${state.exportingFormat ? 'disabled' : ''}>${icon(o.icon)}<span><strong>${o.label}</strong><small>${o.desc}</small></span>${icon('download-simple')}</button>`).join('')}</div>`);
  } else if (d.type === 'reconnect') {
    content=dialogFrame('Reconnect audio',`<p class="dialog-lead">Choose <strong>${esc(rec.originalFilename)}</strong> again ${rec.segments.length?'to listen':'to resume transcription'}.</p><p class="fine-print">${rec.segments.length?'Your transcript and edits are saved.':'You do not need to upload a transcript file.'} Audio files need reconnecting after a page refresh.</p>`,
      '<button class="button secondary" data-action="close-dialog">Cancel</button><button class="button primary" data-action="choose-reconnect" data-id="' + esc(rec.id) + '">Choose audio file</button>');
  } else if (d.type === 'confirm-reset') {
    content=dialogFrame('Reset this demo?', '<p>Restore the sample library and its original names, transcript text and notes. Recordings you added and saved names will be removed from this demo.</p>',
      '<button class="button secondary" data-action="close-dialog">Keep changes</button><button class="button danger" data-action="reset">Reset demo</button>');
  } else if (d.type === 'confirm-remove') {
    content=dialogFrame('Remove recording?', '<p>Remove <strong>' + esc(rec.title) + '</strong> and its edits from this demo library. Your original file will not be changed.</p>',
      '<button class="button secondary" data-action="close-dialog">Keep recording</button><button class="button danger" data-action="remove-recording" data-id="' + esc(rec.id) + '">Remove</button>');
  }
  dialog.innerHTML=content;
  if (!dialog.open) dialog.showModal();
  if (previousFocus) $('#'+previousFocus,dialog)?.focus();
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
  const input=document.createElement('input'); input.type='file'; input.accept='audio/*,video/*,.m4a,.mp3,.wav,.aac,.aiff,.ogg,.flac,.mp4,.mov,.webm'; input.multiple=mode==='upload';
  input.addEventListener('change',async()=>{
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
      localFiles.set(rec.id,file);
      closeDialog();
      if (!rec.segments.length) queueTranscription(rec,file);
      else { rec.status='ready';persist();render();notify('Audio reconnected.'); }
    } else {
      state.pendingFiles=[...state.pendingFiles,...input.files];
      openDialog({type:'upload'});
    }
  });
  input.click();
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
    else if (route().id===rec.id) render();
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
    const step=$('.job-progress-meta > span:last-child',visual);if(step)step.textContent=known?'This step':'';
  });
}
function queueTranscription(rec,file,{resumeJob=null}={}) {
  if (transcriptionMode().configured===false) {
    rec.status='error';rec.transcription={...rec.transcription,status:'error',error:'WhisperX service is not connected yet. Please try again when the service is available.'};
    persist();refreshTranscriptionViews(rec,true);notify('WhisperX service is not connected yet.');return;
  }
  if (transcriptionJobs.has(rec.id)) return;
  const job={id:uid(),recordingId:rec.id,file,resumeJob,controller:new AbortController()};
  if(file)localFiles.set(rec.id,file);transcriptionJobs.set(rec.id,job);transcriptionQueue.push(job);
  const previous=rec.transcription;
  const cancelling=Boolean(resumeJob && previous?.cancelRequestedAt);
  rec.status=cancelling?(previous.cancellationError?'cancellation-unconfirmed':'cancelling'):'queued';rec.transcription={status:rec.status,stage:rec.status,queuedAt:resumeJob && previous?.queuedAt || Date.now(),...(resumeJob?{job:resumeJob,startedAt:previous?.startedAt,...(cancelling?{cancelRequestedAt:previous.cancelRequestedAt,cancellationError:previous.cancellationError}:{})}:{})};
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
function confirmTranscriptionCancellation(rec) {
  const job=transcriptionJobs.get(rec.id);
  transcriptionJobs.delete(rec.id);job?.controller.abort();
  for(let i=transcriptionQueue.length-1;i>=0;i--)if(transcriptionQueue[i]===job)transcriptionQueue.splice(i,1);
  rec.status='cancelled';rec.transcription={...rec.transcription,status:'cancelled',stage:'cancelled',cancelledAt:Date.now()};delete rec.transcription.job;delete rec.transcription.cancellationError;delete rec.transcription.cancelRequestInFlight;
  delete state.processing[rec.id];persist();refreshTranscriptionViews(rec,true);notify('Transcription cancelled.');
}
async function cancelTranscription(rec) {
  const remote=rec.transcription?.job;
  if(!remote?.accessToken) {if(transcriptionJobs.has(rec.id))confirmTranscriptionCancellation(rec);return true;}
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
  if(transcriptionMode().configured===false){notify('WhisperX service is not connected yet.');return;}
  closeDialog();state.pendingFiles=[];
  const batchId='local-'+uid(),uploadedAt=new Date().toISOString();
  const added=files.map(file=>({id:'local-'+uid(),title:file.name.replace(/\.[^.]+$/,'')||file.name,originalFilename:file.name,batchId,uploadedAt,duration:0,source:'local-upload',status:'queued',audioUrl:URL.createObjectURL(file),size:file.size,speakers:[],segments:[],notes:{summary:[],actions:[],decisions:[]},qa:[]}));
  state.recordings.unshift(...added);state.search='';state.expandedId=added[0].id;state.libraryScroll=0;
  navigate();render();
  added.forEach((rec,index)=>{
    localFiles.set(rec.id,files[index]);queueTranscription(rec,files[index]);
    audioMetadata(rec.audioUrl).then(result=>{if(recordById(rec.id)===rec && result.duration){rec.duration=result.duration;persist();refreshTranscriptionViews(rec,true);}});
  });
  notify(files.length+' recording'+(files.length===1?'':'s')+' queued for transcription.');
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
    const url=URL.createObjectURL(result.blob),a=document.createElement('a');
    a.href=url;a.download=result.filename;document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),10000);notify('Transcript exported.');
    if (state.dialog?.type === 'export' && state.dialog.recordingId === rec.id) closeDialog();
  } catch (error) {
    notify('Export could not finish. '+(error.message || 'Please try again.'));
  } finally {
    state.exportingFormat=null;
    if (state.dialog?.type === 'export') renderDialog();
  }
}
function returnToSegment(rec,segmentId,play=true) {
  closeDialog();state.detailTab='transcript';state.transcriptSearch='';
  if(route().id!==rec.id)navigate(rec.id);else render();
  const segment=rec.segments.find(s=>s.id===segmentId);
  if(segment?.start!==null)seekTo(rec,segment.start,play);
  requestAnimationFrame(()=>{const el=$('[data-segment="'+CSS.escape(segmentId)+'"]');el?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'center'});el?.classList.add('citation-target');setTimeout(()=>el?.classList.remove('citation-target'),1800);});
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
  const target=event.target.closest('[data-action]');if(!target)return;
  const action=target.dataset.action;const rec=recordById(target.dataset.id || state.dialog?.recordingId);
  event.preventDefault();
  if(action==='back'){navigate();return;}
  if(action==='go-library'){goToPage('library');return;}
  if(action==='go-upload'||action==='upload'){goToPage('upload');return;}
  if(action==='open'){navigate(rec.id);return;}
  if(action==='search'){state.showSearch=true;render();$('#library-search')?.focus();return;}
  if(action==='close-search'||action==='clear-search'){state.search='';state.showSearch=false;render();return;}
  if(action==='info'){openDialog({type:'info'});return;}
  if(action==='choose-upload'||action==='add-more-files'){chooseFiles();return;}
  if(action==='close-dialog'){closeDialog();return;}
  if(action==='remove-pending'){state.pendingFiles.splice(Number(target.dataset.index),1);renderDialog();return;}
  if(action==='confirm-upload'){addPendingFiles();return;}
  if(action==='preview'){state.expandedId=state.expandedId===rec.id?null:rec.id;refreshList();return;}
  if(action==='batch'){const id=target.dataset.batchId;if(state.collapsedBatches.has(id))state.collapsedBatches.delete(id);else state.collapsedBatches.add(id);refreshList();return;}
  if(action==='play'){toggleAudio(rec);return;}
  if(action==='speaker'){openDialog({type:'speaker',recordingId:rec.id,speakerId:target.dataset.speakerId,segmentId:target.dataset.segmentId,scope:target.dataset.scope || (target.dataset.speakerId === 'unassigned' && target.dataset.segmentId ? 'segment' : 'speaker')});return;}
  if(action==='manage-speakers'){openDialog({type:'speakers',recordingId:rec.id});return;}
  if(action==='segment-menu'){openDialog({type:'segment-menu',recordingId:rec.id,segmentId:target.dataset.segmentId});return;}
  if(action==='edit-segment'){openDialog({type:'edit-segment',recordingId:rec.id,segmentId:target.dataset.segmentId});return;}
  if(action==='reassign-segment'){const segment=rec.segments.find(s=>s.id===target.dataset.segmentId);openDialog({type:'speaker',recordingId:rec.id,speakerId:segment.speakerId,segmentId:segment.id,scope:'segment'});return;}
  if(action==='choose-name'||action==='use-suggested'){$('#speaker-name').value=target.dataset.name;$('#speaker-name').focus();return;}
  if(action==='reject-suggested'){const s=speakerById(rec,state.dialog.speakerId);delete s.suggestedName;persist();renderDialog();notify('Suggestion dismissed. Choose the right name.');return;}
  if(action==='seek-segment'){const segment=rec?.segments.find(s=>s.id===target.dataset.segmentId);if(segment?.start!==null){if(state.dialog)closeDialog();seekTo(rec,segment.start,true);}return;}
  if(action==='cite'){returnToSegment(rec,target.dataset.segmentId,true);return;}
  if(action==='follow'){const current=$('[data-segment].is-current');if(current)current.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'center'});else notify('Start playback to follow the current moment.');return;}
  if(action==='tab'){state.detailTab=target.dataset.tab;state.answer=null;render();return;}
  if(action==='side-tab'){state.sideTab=target.dataset.tab;state.answer=null;render();return;}
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
    if(!await cancelAllTranscriptions()){closeDialog();notify('Cloud cancellation is still pending. Keep this library and reset after confirmation.');return;}localFiles.clear();
    clearAudio();state.recordings.forEach(r=>{if(r.audioUrl?.startsWith('blob:'))URL.revokeObjectURL(r.audioUrl);});
    state.recordings=clone(state.seed);state.knownSpeakers=[];state.processing={};state.expandedId=state.recordings[0]?.id;state.search='';state.libraryScroll=0;state.collapsedBatches.clear();persist();closeDialog();navigate();notify('Demo restored.');return;
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
    const rec=currentRec();state.transcriptSearch=event.target.value;
    const q=state.transcriptSearch.toLowerCase(),segments=rec.segments.filter(s=>!q||(s.text+' '+displayName(speakerById(rec,s.speakerId))).toLowerCase().includes(q));
    $('#transcript-turns').innerHTML=segments.length?segments.map(s=>segmentMarkup(rec,s)).join(''):'<div class="panel-empty"><p>No matching passages.</p></div>';updatePlayers();
  }
  if(event.target.matches('[data-seek]'))seekTo(recordById(event.target.dataset.seek),Number(event.target.value),false);
});
document.addEventListener('change',event=>{
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
      const segment=rec.segments.find(s=>s.id===d.segmentId);let assigned=rec.speakers.find(s=>displayName(s).toLowerCase()===name.toLowerCase());
      if(!assigned){assigned={id:'speaker-'+uid(),name,confirmed:true};rec.speakers.push(assigned);}
      segment.speakerId=assigned.id;
    }else if(speaker.id === 'unassigned'){
      let assigned=rec.speakers.find(s=>s.id !== 'unassigned' && displayName(s).toLowerCase()===name.toLowerCase());
      if(!assigned){assigned={id:'speaker-'+uid(),name,confirmed:true};rec.speakers.push(assigned);}
      rec.segments.filter(s=>s.speakerId === 'unassigned').forEach(s=>s.speakerId=assigned.id);
    }else{speaker.name=name;speaker.confirmed=true;delete speaker.suggestedName;}
    if(data.get('saveName')&&!state.knownSpeakers.some(s=>s.name.toLowerCase()===name.toLowerCase()))state.knownSpeakers.push({id:uid(),name});
    rec.notesStale=true;state.answer=null;persist();closeDialog();render();notify('Speaker updated in this recording.','undo');return;
  }
  if(event.target.id==='segment-form'){
    event.preventDefault();const text=String(new FormData(event.target).get('text')||'').trim(),d=state.dialog,rec=recordById(d.recordingId);
    if(!text){$('#segment-error').textContent='Transcript text cannot be empty.';return;}
    rememberUndo('Text updated',rec.id);rec.segments.find(s=>s.id===d.segmentId).text=text;rec.notesStale=true;state.answer=null;persist();closeDialog();render();notify('Transcript text saved.','undo');return;
  }
  if(event.target.id==='rename-form'){
    event.preventDefault();const title=String(new FormData(event.target).get('title')||'').trim(),rec=recordById(state.dialog.recordingId);if(!title)return;
    rememberUndo('Title updated',rec.id);rec.title=title;persist();closeDialog();render();notify('Recording renamed.','undo');return;
  }
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&!state.dialog&&state.showSearch){state.showSearch=false;state.search='';render();}
  const input=event.target.closest('input,textarea,select,button,a,[contenteditable],dialog');
  if(!input&&!state.dialog&&event.key==='/'){event.preventDefault();if(route().view==='library'){state.showSearch=true;render();$('#library-search')?.focus();}else $('#transcript-search')?.focus();}
  if(!input&&!state.dialog&&event.code==='Space'&&route().view!=='upload'){const rec=currentRec()||recordById(state.expandedId);if(rec){event.preventDefault();toggleAudio(rec);}}
});
document.addEventListener('dragenter',event=>{if(event.dataTransfer?.types.includes('Files')){event.preventDefault();state.dragDepth++;document.body.classList.add('drag-over');}});
document.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault();});
document.addEventListener('dragleave',()=>{state.dragDepth=Math.max(0,state.dragDepth-1);if(!state.dragDepth)document.body.classList.remove('drag-over');});
document.addEventListener('drop',event=>{
  if(!event.dataTransfer?.files.length)return;event.preventDefault();state.dragDepth=0;document.body.classList.remove('drag-over');
  const files=[...event.dataTransfer.files].filter(f=>f.type.startsWith('audio/')||f.type.startsWith('video/')||/\.(m4a|mp3|wav|aac|aiff?|ogg|flac|mp4|mov|webm)$/i.test(f.name));
  if(!files.length){notify('Drop audio or video files to add a recording.');return;}
  state.pendingFiles=files;openDialog({type:'upload'});
});
window.addEventListener('scroll',()=>{if(state.lastView==='library'&&route().view==='library')state.libraryScroll=window.scrollY;},{passive:true});
window.addEventListener('hashchange',()=>{const next=route();state.transcriptSearch='';state.detailTab='transcript';state.answer=null;render();window.scrollTo({top:next.view==='library'?state.libraryScroll:0,behavior:'instant'});});
init();
