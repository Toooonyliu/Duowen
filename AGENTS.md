# Prototype Instructions

## Product decisions

The visual source is `design/reference-library.png`; colors and component rules are in `design/visual-spec.json`. Preserve the user's minimal Apple-inspired frosted recording modules, icon-led familiar actions, readable filenames/times/statuses, and consistent library/detail surfaces. Browser QA must include timestamp seeking, speaker correction, file upload and narrow screens.

The three main routes are Upload (default entry), Library (upload batches and processing/history), and a single recording's transcript detail. Use the user's selected Studio Brainstorming excerpt as the real bundled sample, with provenance and unverified local ASR clearly identified. Uploaded files remain in the browser for playback and optional subtitle import; live server transcription and cross-recording voice matching still require backend integration. Exports include real PDF, Markdown, TXT and Word DOCX, plus subtitle/JSON options.

The user has authorized the current app version in the public Toooonyliu/Duowen repository and a published GitHub Pages website. Preserve the existing private project backup separately. Keep tokens, environments, model caches, original long recordings, HR/interview recordings and generated local validation artifacts out of commits. Only the explicitly selected 90-second Studio Brainstorming excerpt is included in the public app; keep all other original recordings out of this repository. GitHub Pages must retain relative asset paths so /Duowen/ works.

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
