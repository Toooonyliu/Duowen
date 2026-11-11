# Prototype Instructions

## Product decisions

The user asked (2026-11) for the interaction and reading experience to follow the calm, low-friction feel of Wispr Flow. That direction now leads; `design/reference-library.png` and `design/visual-spec.json` describe the earlier mineral/petrol look and remain only as the source of the petrol accent. Current rules:

- **Frame:** on wide screens a cream canvas holds a left sidebar (Duowen, New transcript, Home, Library, recent recordings, About) and one white content sheet; below 960px the sidebar folds into a top bar. "New transcript" opens the file picker from any screen.
- **Surface:** warm near-black ink on cream and white, petrol only as the accent, one serif display voice (`--display`) for titles, pill buttons, ruled list rows instead of cards. No frosted glass, no icon-only primary actions.
- **Flow:** dropping or choosing a file starts transcription immediately with no confirmation dialog. One file opens straight into its recording; a batch lands in the Library. Home lists recent recordings under the dropzone.
- **Transcript:** reads like a document. The speaker is named once per turn with a stable per-speaker color; every paragraph keeps a quiet timestamp in the left gutter; body text is 17px/1.75 at a 66ch measure. Each sentence is clickable and plays from its exact timestamp. Copy, edit and change-speaker appear on paragraph hover or after tapping the paragraph; text is edited inline (Enter saves, Esc cancels), never in a modal, and every sentence keeps its own timing.
- **Listening:** the player is docked to the bottom of the viewport. While audio plays the spoken sentence is highlighted and kept in view; manual scrolling pauses following and shows "Back to current line". Space, ←/→ and / are the keyboard shortcuts.
- **Search:** find-in-transcript highlights matches in place with a count and Enter / Shift+Enter navigation. It never hides the surrounding conversation.
- **Waiting:** while a recording is transcribed, show one status line, one progress bar and a skeleton of the transcript to come. No multi-step stepper.
- **Tabs:** Notes appears only when a recording actually has notes; Ask stays available for every transcript. Do not show an empty Notes tab.
- **Scrubbing:** releasing the seek bar scrolls the transcript to that moment.

Browser QA must include timestamp seeking, speaker correction, inline text editing, file upload and narrow screens.

The three main routes are Upload (default entry), Library (upload batches and processing/history), and a single recording's transcript detail. Use the user's selected Studio Brainstorming excerpt as the real bundled sample, with provenance and unverified local ASR clearly identified. New uploads use the real WhisperX backend; the frontend requires its public URL. Show genuine queued/processing/completed/failed states, and retain task ownership until remote cancellation is confirmed. The whole card's noninteractive area opens the recording. Subtitle import is optional. Cross-recording voice matching and model-backed notes/questions remain future work. Exports include real PDF, Markdown, TXT and Word DOCX, plus subtitle/JSON options.

For hosting changes, read `deployment/README.md` for the cost proposal and deployment sequence. The user selected WhisperX and requested a paid-cloud cost proposal; subscription approval remains required before creating paid infrastructure. Keep the existing public main deployment until the cloud endpoint has passed real upload, CORS, resume and cancellation checks.

The user has authorized the current app version in the public Toooonyliu/Duowen repository and a published GitHub Pages website. Preserve the existing private project backup separately. Keep tokens, environments, model caches, original long recordings, HR/interview recordings and generated local validation artifacts out of commits. Only the explicitly selected 90-second Studio Brainstorming excerpt is included in the public app; keep all other original recordings out of this repository. GitHub Pages must retain relative asset paths so /Duowen/ works.

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
