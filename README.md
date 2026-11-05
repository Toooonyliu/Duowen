# Duowen

A minimal transcript workspace: **Upload → Library → Recording**.

Website: https://Toooonyliu.github.io/Duowen/

## Features

- Select audio/video files and browse upload batches and history.
- Review timestamped transcripts; seek audio; rename or assign speakers and edit text.
- Export PDF, Word DOCX, Markdown, TXT, SRT, VTT and JSON.
- PDF runs in a background worker with recoverable errors and a 60-second job limit.
- Prepared notes and example questions link back to transcript passages.

## Current prototype limits

The bundled sample is the first 90 seconds of `360 Studio Brainstorming.m4a` (original 08:40). Local WhisperX produced an uncorrected Chinese ASR draft with approximate segment timestamps. Automatic speaker separation has not run; Unknown speaker means unassigned. The sample is included for this user-authorized public demo. Original long recordings and other recordings are excluded.

New files are read only in your browser for playback; you can import SRT/VTT/TXT transcripts. This frontend does not yet run automatic transcription, voice matching or live model-backed questions. Local file playback may require reconnecting after reload. Browser metadata and edits use localStorage.

## Development

```sh
npm ci
npm run dev
```

Build: `npm run build` (static output: `dist/client`). Tests: `node --test tests/exporters.test.mjs`. Standalone HTML: `npm run export:html` (large because it embeds the audio, icons, PDF worker and Chinese font).

GitHub Pages builds on every push to `main` through `.github/workflows/pages.yml`. Relative Vite asset paths support the `/Duowen/` project URL and root-domain hosts. Hash routes allow direct links without server rewrites. No credentials or backend environment variables are required for this demo.

PDF embeds the full Noto Sans SC font to avoid missing Chinese glyphs, producing a roughly 6.5 MB sample PDF. Font and icon licenses/provenance are in `licenses/`. Browser and export verification are recorded in `design-qa.md` and `qa/export-validation.md`.
