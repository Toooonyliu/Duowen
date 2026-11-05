# Demo design and interaction QA — v2

Date: 2026-11-05, America/New_York. This report supersedes the synthetic-sample v1 report archived at `qa/design-qa-v1.md`.

## Scope and result

The requested workflow is **Upload → Library → Recording detail**. The bundled fixture is now a real, locally transcribed 90-second Chinese excerpt from the user-selected Studio Brainstorming recording. No new P0/P1/P2 issues remain in the tested website flows; an independent source review reached the same result. This is prototype QA, not a transcription accuracy benchmark or real-user study.

## Visual evidence

The selected mineral-white/petrol reference and component tokens remain `design/reference-library.png` and `design/visual-spec.json`. The earlier full and focused comparisons remain in `qa/screenshots/library-comparison-final.jpg` and `library-focus-final.jpg`; both contain the reference and implementation. Current screenshots show the authorized workflow/content changes, not a claim of exact pixel fidelity to the earlier three-recording illustration.

- `qa/screenshots/v2-upload-desktop.jpg`: obvious audio/video chooser with restrained surfaces and icons.
- `qa/screenshots/v2-library-desktop.jpg`: filename, original filename, upload batch, excerpt duration and qualified state.
- `qa/screenshots/v2-detail-desktop.jpg`: one consistent player/transcript/notes composition with real Chinese text.
- `qa/screenshots/v2-uploaded-library.jpg`: an actual local import and the existing sample in separate batches.
- `qa/screenshots/v2-upload-mobile.jpg`, `v2-library-mobile.jpg`, `v2-detail-mobile.jpg`: 390px viewport. DOM scrollWidth was 390px on each route.
- Current desktop captures use 1440×1024 CSS viewport; the detail full-page image includes content below the fold. No overflow-hiding mask was added.

Typography, bounded reading measure, spacing, icon weights, mineral/petrol/ice colors and accessible labels are shared across all routes. Transcript content is structured by time and speaker, not a raw text dump. Unknown speaker uses an unassigned label; no invented identity, avatar or separation result is shown. Earlier contrast and tooltip overflow fixes remain intact.

## Browser checks

- Default entry renders Upload; sample entry opens Library; recording links open detail; return controls work.
- Selected an actual MP3 through the native file chooser, confirmed Add 1 recording, and landed in Library with a measured 01:30 duration and a new batch. It reports Add transcript / Audio is available. A new document load requires reconnecting local audio, as explained by the UI. The temporary test record was removed through the app; original file was untouched.
- Bundled sample playback reports duration 90, no media error, and paused=false. Timestamp 00:36 sought to 36.44 seconds. Standalone embedded media was also observed as a data URL with duration 90 and successful playback.
- Website downloads completed for PDF, DOCX, Markdown and TXT. PDF is a real 6,454,755-byte PDF. Exported content retains uncorrected ASR, approximate timing and unidentified speaker qualifications.
- Real sample shows Transcript ready / Speakers unassigned and ASR draft. Unassigned is a bucket, not an asserted count of one speaker. Manual speaker assignment and transcript edits remain available; prior v1 browser checks covered rename scope and undo.
- Source review checked route recovery, processing-state transitions, export failure cleanup, empty transcript rejection and all seven export branches. New local uploads do not receive fabricated transcripts. Prepared notes/questions remain explicitly labeled; unknown questions search current text.

## Export validation

`node --test tests/exporters.test.mjs` passed all format tests. Independent PDF and Word rendering checked Chinese and multi-page mixed-language documents. Evidence and limitations: `qa/export-validation.md`, `qa/screenshots/export-pdf-real.png`, `export-word-real.png`. Word is genuine DOCX (OOXML), not a renamed HTML file.

## Build and delivery

Production build and self-contained export succeeded. Build reports a large JS chunk because document generators are bundled; this is a nonblocking prototype performance follow-up. The standalone HTML embeds the sample MP3, seed JSON, CSS, scripts, icon fonts and Noto PDF font, around 23 MB. Third-party JS literal control characters are escaped when embedding into HTML to keep Vite/HTML parsing valid. Direct file:// navigation is restricted by this browser tool, so testing uses local HTTP.

## Known limits

The sample ASR has audible homophone errors and only approximate segment timing. Diarization has not run. Automatic server transcription, reliable completion estimates, voice matching and model-backed questions are not connected. Original long recordings, interview audio, environment credentials and caches are excluded from the private GitHub backup. A repository backup is distinct from a hosted website.

## Background PDF processing

Production browser testing prompted isolation of CPU-heavy PDF work from the page. PDF now runs in a dedicated worker with a transferred font buffer and a 60-second job timeout; Word/text paths remain direct. Worker start/errors/timeouts reject into the existing recoverable export UI rather than falling back to blocking the page. Speaker names are resolved and the document is deeply snapshotted before awaiting font loading; completing one recording cannot close a different recording’s export dialog.

A real worker bridge generated the Chinese PDF in 5.25 seconds while the main event-loop heartbeat continued. Production browser verification observed Preparing PDF and downloaded a real result. Browser-tool download transfer overhead was highly variable, so it is not treated as an application latency measurement. Independent checks found no AST/value difference between the original production bundle and the HTML-escaped bundle. All seven core document tests passed, including the embedded-base64-font path.

The final self-contained HTML was served as a static file from the production preview. Its embedded-worker PDF path showed Preparing PDF, completed with Transcript exported, released the dialog lock, and reported no browser console errors. Its audio and three routes had already been verified. Direct file:// remains outside this browser tool’s policy; no bypass was attempted.

final result: passed
