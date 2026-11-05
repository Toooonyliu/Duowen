# Real-upload verification — November 5, 2026

The local frontend at port 4175 connected to the real API at port 8765. A newly synthesized 10.91-second WAV absent from the sample library was uploaded through the browser file chooser. WhisperX 3.3.2 in the existing Intel Mac environment produced five timestamped segments, including “Maria will send the budget on Friday” and “The code word is blue lantern.” It recognized “Duowen” as “Duane”; output remains an unreviewed ASR draft. The separate API smoke took 46.74 seconds. No diarization token was available, so speakers correctly remained unassigned.

Observed in the browser:

- Clicking the body of a recording card opens its detail view.
- Upload/queue/model-loading progress is visible, with a spinner, indeterminate stage bar and elapsed time.
- Reloading during actual inference resumes the existing task and displays its completed transcript without another upload.
- Cancelling a running task first shows waiting for service confirmation, then shows cancelled after the server confirms. The next file in the batch proceeds.
- Invalid media reaches an explicit failure state and offers Retry transcription. Automatic transcription does not require importing subtitles.
- The recording header link opens with Enter. Preview and timestamp buttons stay in Library; selecting the sample's 00:16 timestamp starts playback at that time. At 390 px, Library and detail have no horizontal overflow, and icon-only speaker/follow controls retain accessible names.

Regression harnesses exercised the actual UI functions and went red on the previous implementation: zero automatic jobs, incomplete card navigation and required transcript import. The corrected flow passes. Additional state checks cover refresh ownership, delayed completion during edit undo, offline cancellation, pending server cancellation, and local abort/timeout without discarding the remote capability.

Node integration tests cover real HTTP upload/poll/cancel contracts, URL validation, cold-start readiness, busy admission, failed responses and result normalization. Backend lifecycle tests use a clearly identified subprocess fixture; they verify HTTP, SQLite, admission limits, ownership, cancellation, timeouts and restart behavior, independently of real inference.

Not yet verified: the Linux production Docker image, HF proxy CORS/Bearer handling, cloud latency, gated speaker clustering, and the public site connected to that backend. These remain release checks after the owner approves cloud spending and configures access. No speaker identity recognition or model-backed notes/Q&A was added in this change.
