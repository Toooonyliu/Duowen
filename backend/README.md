# WhisperX transcription backend

This is an optional **real server-side WhisperX** service for Duowen. GitHub Pages hosts the frontend; it cannot execute Python, FFmpeg or WhisperX. The frontend must be built with `VITE_TRANSCRIPTION_API_URL=https://YOUR-SERVICE` (no trailing `/api`), or receive the equivalent runtime backend URL. No provider key belongs in a `VITE_` variable.

## Run and deploy

The Docker build uses **Python 3.11 on Linux x86_64**, WhisperX **3.8.6**, CPU Torch/Torchaudio **2.8.0**, Torchvision **0.23.0**, Transformers **4.57.6**, Pyannote Audio **4.0.7**, and NumPy **2.3.5**. Python 3.11 is intentional: the newer NumPy 2.5 series requires Python 3.12. The production image's complete native installation has not been executed on this Intel Mac; the real local inference validation uses the already-installed legacy Mac-compatible environment described below.

Run from the repository root, using `backend` as the **Docker build context**:

```sh
docker build -t duowen-whisperx backend
docker run --rm -p 7860:7860 \
  -v duowen-data:/data \
  -e DUOWEN_ALLOWED_ORIGINS=https://toooonyliu.github.io \
  -e HF_HOME=/data/model-cache/huggingface \
  -e TORCH_HOME=/data/model-cache/torch \
  duowen-whisperx
```

The HTTP process must run as **one ASGI worker and one replica**, with one native inference process at a time. A filesystem lock rejects an accidental second worker using the same data directory. CPU inference uses `int8` and batch size 1; changing models or adding GPU/CUDA requires measuring that target rather than reusing the CPU estimate.

For an API-only development environment, install `requirements-api.txt`, provide `DUOWEN_INFERENCE_PYTHON` pointing to an existing WhisperX Python environment, place FFmpeg on `PATH`, then run:

```sh
python -m uvicorn backend.api:app --host 127.0.0.1 --port 8765 --workers 1 --no-access-log
```

All configuration fields are shown in `.env.example`; load runtime variables through the host's environment/secret mechanism. Do not commit an actual `.env` or Hugging Face token. The image runs as UID 1000 and uses `PORT` when supplied by the host.

## HTTP contract

- `GET /api/health` returns a coarse API status. It does not preload or guarantee cached model weights.
- `POST /api/jobs`, multipart `file`, optional `language=auto`, returns **202** with `{id, accessToken, status, stage, percent}`. Treat `accessToken` as a private per-job capability and store it only with that user's task. The database retains only its SHA-256 digest.
- `GET /api/jobs/{id}` requires `Authorization: Bearer <accessToken>` and returns `{id,status,stage,percent,detail,result?,error?}`. It cannot list or read other visitors' jobs. Its first successful authenticated poll acknowledges receipt of the capability and starts queue eligibility; uploads abandoned before receiving their response therefore do not start expensive inference. Unacknowledged uploads expire after two minutes.
- `DELETE /api/jobs/{id}` requires the same bearer token. A queued/running job is cancelled; the process group is terminated and the media is removed. A completed/failed result is deleted. Cancellation racing completion does not report a completed transcript after a cancellation was acknowledged.

Statuses are `queued`, `processing`, `completed`, `failed`, `cancelled`. Stages include `queued`, `model-loading`, `decoding`, `transcribing`, `aligning`, `diarizing`, and terminal stages. Native progress callbacks, where available, supply a **stage-specific** percentage; model download/import or older WhisperX versions remain indeterminate rather than advancing a fake timer. The frontend can display elapsed time while the model works. No unsupported completion ETA is invented.

Results contain timestamped `segments`, editable speaker cluster labels, detected `language`, `duration`, `timingSource`, `diarizationStatus`, and `engine: "whisperx"`. Text is an uncorrected ASR draft. Automatic alignment is not a measured accuracy guarantee. Unsupported/failed alignment retains approximate ASR segment times. Default alignment languages are English and Chinese to bound the number of large cached aligners; other languages still receive ASR text and approximate timestamps. An owner can explicitly expand `DUOWEN_ALIGN_LANGUAGES` after provisioning storage.

## Resource boundaries and storage

Defaults: 100 MB file, 30-minute audio, four total pending/in-flight uploads, five upload attempts per IP per hour, one inference at a time, 30-minute processing deadline, 2 GB job-data quota and 24-hour result retention. IP addresses are reduced to salted digests for the limiter. Upload slots are reserved **before multipart parsing**, so concurrent visitors cannot each spool an upload while the queue still appears empty. Actual FFmpeg decoding checks for an audio stream and duration; extensions are not treated as proof that media is valid. Original filenames are reduced to basenames and never used as server paths.

The upload and decoded media are deleted after a terminal result; transcript results live in SQLite, outside process memory. Cancellation and timeout kill the native process group. On restart, queued acknowledged jobs resume if their input files still exist, while a previously active job becomes an explicit interrupted error. Native stderr and credentials are never returned in public error responses.

**Durability requires an actual persistent local volume** mounted at `DUOWEN_DATA_DIR`. SQLite must not be placed on a bucket/FUSE object-store mount with unverified locking. On an ephemeral host/container, container replacement may erase SQLite and queued inputs. The frontend then needs to show a missing/interrupted task and request the original recording again; it must not claim that a lost job is still processing. Completed transcripts should also remain in the user's browser. Job storage and model-cache space are separate: the 2 GB quota does not include model weights; provision additional cache disk explicitly.

## Speaker separation

The Docker image enables NVIDIA Nemotron by default. When running the Python API outside Docker, `DUOWEN_DIARIZE=0` leaves speakers unassigned. To use WhisperX's pyannote pipeline, set `DUOWEN_DIARIZE=1`, leave both NeMo path variables empty, and provide a read-only `HF_TOKEN` as a server runtime secret. The Linux WhisperX version uses [community-1](https://huggingface.co/pyannote/speaker-diarization-community-1). The older Intel Mac environment uses [speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1) and [segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0). Accept the access conditions for the models used by your environment.

To use NVIDIA's public model for local speaker separation, also set `DUOWEN_NEMO_SPEECH_BIN` and `DUOWEN_NEMO_DIARIZATION_MODEL` to the absolute paths of the [NeMo-Speech.cpp v0.3.0 executable](https://github.com/NVIDIA/NeMo-Speech.cpp/releases/tag/v0.3.0) and the [Nemotron-3-Diarization GGUF model](https://huggingface.co/nvidia/Nemotron-3-Diarization). With both paths set, NeMo runs on CPU for speaker separation and WhisperX provides the transcript, timestamps and speaker assignment. This path needs no token after downloading the public artifacts. Speaker labels are editable clusters. If separation cannot run, the transcript remains available and its speaker status reflects the failure.

## Hosting suitability and measured resource use

A real cached-model Intel Mac measurement of WhisperX 3.3.2/base/int8 plus the Chinese aligner used **2.38 GiB peak RSS** and **79.50 s wall time for 90 s audio**. No diarization ran. That makes a 2 GB instance unsuitable; 4 GB is only a constrained starting hypothesis, while **8 GB or more** is the safer starting recommendation for production dependencies and alignment. The newer Linux 3.8.6 image and a cloud CPU must be benchmarked independently. These figures are not a cloud SLA or an ASR accuracy score.

Hugging Face's current documentation lists CPU Basic at **2 vCPU / 16 GB RAM / 50 GB non-persistent disk** with no CPU-hour charge, but creating a Docker or Gradio compute Space now requires an eligible **paid plan**. It is not described here as a universally free backend. Docker Spaces use port 7860 by default and UID 1000. Publishing there requires the owner's Hugging Face account/plan and repository write authorization; model access additionally needs the relevant read-token agreement. No paid service has been created by this backend implementation.

Sources checked November 5, 2026:

- [WhisperX Python API and model authorization](https://github.com/m-bain/whisperX)
- [Stable WhisperX package metadata](https://pypi.org/project/whisperx/3.8.6/)
- [Spaces compute requirements and default hardware](https://huggingface.co/docs/hub/spaces-overview)
- [Docker Spaces port, secrets and user permissions](https://huggingface.co/docs/hub/spaces-sdks-docker)

## Verification

Install `httpx==0.28.1` alongside API requirements for tests:

```sh
python -m unittest discover -s backend/tests -v
python backend/scripts/smoke_whisperx.py --url http://127.0.0.1:8765 \
  --audio /path/to/actual-recording.wav --output /tmp/whisperx-result.json
```

The API tests exercise real HTTP handling, SQLite persistence, capability ownership, upload admission before body parsing, rate/size/queue limits, child-process cancellation, timeouts and restart recovery. Their native-process fixture is explicitly a queue protocol test, not an inference claim. Separately, a **new 10.91-second recording absent from the sample library** was uploaded through the live local API and transcribed by real WhisperX. The result contained the requested budget/Friday/blue-lantern phrases, five aligned segments and valid bounds; it completed in **46.74 seconds**. Names still need human review: “Duowen” was recognized as “Duane.” No model-backed summary or speaker identification is claimed by that test.
