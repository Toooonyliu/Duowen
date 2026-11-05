# Transcript export validation

Validated on November 5, 2026. **PASS** for PDF, Word (`.docx`), Markdown (`.md`) and plain text (`.txt`). Word uses the standard OOXML format; no HTML/RTF is disguised as a legacy `.doc` file.

Run from `interactive-demo` after `npm ci`:

```sh
node --test tests/exporters.test.mjs
```

All **7 tests passed**. The tests generate real files and check PDF magic bytes, pagination and title; Word ZIP/OOXML contents and XML escaping; Chinese/English text; timestamps; speaker names and renames; missing-time labels; safe filenames; and draft/approximate-timing/unassigned-speaker qualifications. Set `EXPORT_QA_DIR` to retain the generated test documents in a chosen temporary directory.

The standalone integration test supplies the complete font through `window.__TRANSCRIPT_EXPORT_FONT__` as base64 and deliberately omits `options.fontBytes`. It exports the real Chinese sample, then decompresses the generated PDF's actual `FontFile2` stream and checks it byte-for-byte against the source TrueType font. This covers the large base64 decoding path that direct-byte export tests bypassed. The measured export completed in **3,227 ms** against a **20,000 ms** regression budget and produced a **6,454,380-byte** PDF. This timing was measured in Node with the standalone browser-font global; it does not claim to benchmark browser rendering or download UI.

Independent verification used Poppler to render the actual PDFs, pypdf to extract their selectable Unicode text, and LibreOffice to render the actual DOCX files. Both the real 90-second Chinese excerpt and a longer mixed Chinese/English transcript were inspected. The real sample rendered as one page; the longer PDF rendered across five pages without overlapping or clipped content. Chinese, Latin accents, XML metacharacters, timestamps and speaker names survived. The exported sample retains its raw ASR wording and explicitly identifies it as an uncorrected draft with approximate timestamps and unassigned speakers.

The two retained screenshots show the final output, including its qualifications:

- [PDF screenshot](screenshots/export-pdf-real.png)
- [Word screenshot](screenshots/export-word-real.png)

PDF uses an embedded static Noto Sans SC TrueType font, so the Chinese text remains readable offline without an installed CJK font. The font is fetched on first PDF export or supplied by the standalone build. Runtime CJK font subsetting failed visual QA despite passing text extraction, so the final implementation embeds the complete font and disables localized glyph substitution. This deliberately increases the sample PDF to approximately **6.45 MB**. Font source, conversion, license and SHA-256 are recorded in [Noto-source.json](../licenses/Noto-source.json). Word preserves Unicode and requests Noto Sans SC with the reader's normal fallback when that font is unavailable; its layout can vary between word processors.

Implementation dependencies: [pdf-lib](https://pdf-lib.js.org/) `1.17.1`, [pdf-lib/fontkit](https://github.com/Hopding/fontkit) `1.1.1`, and [docx](https://docx.js.org/) `9.15.2`. No transcript is sent to an external document conversion service.

Browser PDF generation is wrapped by `src/export-client.js` and `src/export-worker.js`. The worker receives an immutable document snapshot with resolved speaker names and a transferred copy of the font buffer; errors and a 60-second deadline return a recoverable UI error. A real Node worker_threads bridge verified the final Chinese PDF (including Unicode, rename and draft qualifications), continuous main-thread heartbeat, unsupported-worker errors and timeout termination. Production browser checks verified the Preparing state and a completed PDF download. Browser-tool transfer latency is excluded from performance claims.
