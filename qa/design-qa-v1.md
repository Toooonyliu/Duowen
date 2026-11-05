# Demo design and interaction QA

Date: 2026-11-05 (America/New_York)

**Findings**

No actionable P0/P1/P2 findings remain in the tested demo flows. The source is a visual concept; measured sample durations and authored sample data replace its illustrative values.

**Evidence and normalization**

- Source visual truth: `design/reference-library.png`, 1487×1058 pixels.
- Desktop CSS viewport: 1440×1024, devicePixelRatio 1. Canonical implementation capture: `qa/screenshots/library-desktop-full.jpg`, 1440×1024 pixels. The concept is proportionally padded to the same dimensions for comparison, not stretched.
- Full-view comparison: `qa/screenshots/library-comparison-final.jpg`. Focused module/player/transcript comparison: `qa/screenshots/library-focus-final.jpg`. Both source and implementation appear in each comparison artifact.
- Detail evidence: `qa/screenshots/detail-desktop-final.jpg`, 1440×1358 full-page capture at desktop viewport. Detail is a new requested view using the same tokens; there was no separate detail mock to claim pixel fidelity against.
- Mobile CSS viewport: 390×844. Final captures: `qa/screenshots/library-mobile-full-final.jpg` and `qa/screenshots/detail-mobile-full-final.jpg`. DOM scrollWidth equals 390 on both screens and with keyboard focus.
- The browser's viewport-only screenshot method sometimes returned a clipped bitmap after a tab/viewport change. Those early or clipped captures are retained as diagnostics, not used as final fidelity evidence. Canonical final comparisons use full-page capture with measured CSS and bitmap sizes.

**Required fidelity surfaces**

- Typography: system font, lighter medium file titles, 18px preview text and 16px detail text; preview wraps to a bounded measure. Metadata and sidebar text were enlarged after the first comparison. The concept's enlarged raster lettering is normalized to usable native UI sizes; this is an intentional implementation adaptation.
- Spacing/layout: shared outside edges, 1200px desktop library, consistent recording/time/status columns, rounded modules and compact controls. Library/detail use the same component family. Three samples and their upload batches remain identifiable.
- Color: mineral-white, petrol and ice-cyan system shared across both views. Independently reviewed secondary/muted/warning colors were darkened for text contrast. Final source tokens are in `design/visual-spec.json`.
- Asset quality: no photographs, avatars or illustrations in the target. UI icons are the official locally bundled Phosphor Regular font, not traced or handcrafted SVG artwork. Audio fixtures are real playable synthetic speech.
- Copy/content: file and speaker names remain readable; familiar actions are icons with accessible names. Samples, prepared notes/answers, local upload and processing simulations are explicitly distinguished. No real transcription or voice-recognition success is claimed.

**Comparison and fix history**

1. Initial implementation comparison (`library-comparison-v1.jpg`): P2 overly small recording labels/metadata relative to the target, and long one-line preview text. Fixed library width/proportions, title/meta/preview sizes, reading measure and shared control size. Re-captured (`library-desktop-v2.jpg`) and compared again in the final pair. No remaining blocking drift; lighter shadows and native icon weights are acceptable minor differences.
2. Mobile P2 horizontal overflow: library scrollWidth 431 and detail 449 at width 390. Actual element boxes fit; hidden pseudo-element tooltips expanded the scrollable area. Fixed hidden tooltip display and inward alignment; no overflow-hiding mask was used. Rechecked both views and focused controls: scrollWidth 390. Final mobile full-page captures record the fixed state.
3. Functional review P2s: empty-library persistence, stale notes/answers, processing timers after reset/remove, semantic overmatching of prepared Q&A and TXT speaker grouping. Builder and independent reviewer verified fixes. Prepared answers now require exact normalized questions; other input returns current transcript excerpts. Edited transcripts invalidate prepared results.
4. Media-reading state was separated from the simulated transcription stages. A real local metadata read no longer displays the demo queued/transcribing timeline.

**Primary interactions tested in the in-app browser**

- Played embedded sample speech: duration 32.825034, readyState 4, no media error. Timestamp/citation seeking reached the intended passage (including 14.3125 seconds for the upload-flow citation).
- Changed a speaker throughout one recording: three turns updated. Changed one turn only: two original-name turns and one new-name turn. Undo restored the three original-name turns. Reload retained the saved name.
- Filtered library by “research”; only the corresponding recording remained.
- Selected two actual local audio files; they appeared as separate records in one new batch, with measured durations and an explicit request to add a transcript.
- Imported a VTT file into an uploaded recording: two timestamped turns and two speakers appeared. Exported JSON contained the two turns and names and omitted the audio URL.
- Used prepared Q&A and source buttons; citations returned to transcript and playback. Mobile Notes/Ask/Transcript switching and citation return were verified.
- Ran the recoverable-error processing demonstration; returning to the recording preserved its six transcript turns.
- Keyboard focus remained visible and did not enlarge the mobile scrollable width.
- Independently exercised actual subtitle/question parser functions for TXT, SRT and VTT and verified sample segment/citation references.

**Build and standalone checks**

- `node --check src/main.js` and production build passed.
- `Transcript-Demo.html` contains inline sample data, CSS, JavaScript, icon fonts and three WAV recordings; no external script or stylesheet link is required by the exported document.
- Served the standalone HTML over local HTTP and tested its embedded audio and detail navigation. Its fresh browser console contained only Vite connection debug entries, no errors.
- Direct `file://` navigation is disallowed by the in-app browser's URL policy. No bypass was attempted. Direct double-click execution is therefore not browser-verified here; the same standalone document was verified through the allowed HTTP preview.

**Open questions and limits**

Real WhisperX/API transcription, automatic voice identity matching and model-backed question answering are the next integration phase. The samples use locally generated speech, authored transcripts/notes and measured timings. This is a frontend demo, not an accuracy evaluation or real-user usability study.

**Follow-up polish**

- P3: fine-tune the concept's subtle material/reflection treatment against actual display preferences.
- P3: evaluate longer real meetings and very large libraries after the backend is connected.

**Implementation checklist**

- [x] Core demo flows function.
- [x] Five fidelity surfaces reviewed, including focused visual evidence.
- [x] Identified P0/P1/P2 issues fixed and rechecked.
- [x] Desktop and narrow layouts checked.
- [x] Standalone export and local preview available.
- [x] Runtime/demo boundaries visible.

final result: passed
