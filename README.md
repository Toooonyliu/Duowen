# Duowen

A minimal transcript workspace: **Upload → Library → Recording**.

Website: https://Toooonyliu.github.io/Duowen/

## Features

- Select audio/video files and browse upload batches and history.
- Upload to a real WhisperX service, follow processing stages, resume after reload and cancel remote work.
- Review timestamped transcripts; seek audio; rename or assign speakers and edit text.
- Export PDF, Word DOCX, Markdown, TXT, SRT, VTT and JSON.
- PDF runs in a background worker with recoverable errors and a 60-second job limit.
- Prepared notes and example questions link back to transcript passages.

## Transcription integration and current limits

The bundled sample is the first 90 seconds of `360 Studio Brainstorming.m4a` (original 08:40). Local WhisperX produced an uncorrected Chinese ASR draft with approximate segment timestamps. Automatic speaker separation has not run; Unknown speaker means unassigned. The sample is included for this user-authorized public demo. Original long recordings and other recordings are excluded.

This branch integrates real server-side WhisperX. Set the public service URL before building; without it, the app explicitly says the service is not connected and does not pretend to transcribe. GitHub Pages serves the frontend and cannot execute WhisperX. The existing public site is not upgraded until the proposed cloud service is approved, deployed and verified. See [deployment and costs](deployment/README.md) and the [backend HTTP contract](backend/README.md).

Speaker separation requires the owner's gated-model authorization and a server-only read token. Until it runs successfully, speakers stay unassigned. Named voice recognition across recordings and live model-backed questions are not implemented. Local file playback may require reconnecting after reload; completed transcripts, metadata and edits use browser localStorage. Subtitle import is optional, never a prerequisite for automatic transcription.

## Development

```sh
npm ci
VITE_TRANSCRIPTION_API_URL=http://127.0.0.1:8765 npm run dev
```

Run the backend as described in its README. Build: `npm run build` (static output: `dist/client`). Tests: `node --test tests/*.test.mjs`. Standalone HTML: `npm run export:html` (large because it embeds the audio, icons, PDF worker and Chinese font; automatic transcription still needs an accessible backend).

GitHub Pages builds on every push to `main` through `.github/workflows/pages.yml`. Its `TRANSCRIPTION_API_URL` repository Actions variable supplies the public service origin; it contains no credential. Relative Vite asset paths support the `/Duowen/` project URL and root-domain hosts. Hash routes allow direct links without server rewrites. Read [real-upload verification](qa/whisperx-validation.md) for the tested behavior and remaining cloud checks.

PDF embeds the full Noto Sans SC font to avoid missing Chinese glyphs, producing a roughly 6.5 MB sample PDF. Font and icon licenses/provenance are in `licenses/`. Browser and export verification are recorded in `design-qa.md` and `qa/export-validation.md`.
