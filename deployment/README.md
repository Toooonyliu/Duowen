# WhisperX cloud proposal

Status on November 5, 2026: real local inference and browser integration work; no paid cloud resource or subscription has been created. The public GitHub Pages site still serves the previous prototype. Source changes are kept on a review branch until the service is ready.

## Cost and initial configuration

Keep GitHub Pages for the frontend. The proposed backend is one public Hugging Face **Docker Space**, **CPU Basic**, **2 vCPU / 16 GB RAM**, one replica and one inference process. Start with WhisperX `base`, CPU `int8`, batch size 1. This is a low-volume project deployment, not a guaranteed latency or availability plan.

| Option | Compute | Approximate monthly total, before tax |
| --- | --- | --- |
| Recommended: PRO + CPU Basic | No hourly CPU charge | **US$9** PRO subscription |
| PRO + CPU Upgrade (8 vCPU / 32 GB) | US$0.03/hour | US$30.90 at 730 running hours |
| PRO + T4 small (4 vCPU / 15 GB RAM, 16 GB VRAM) | US$0.40/hour | US$301 at 730 running hours |

The subscription is account-wide: an owner who already has PRO does not need a second subscription for this Space. The figures exclude taxes and optional storage. Compute Spaces currently require an eligible paid plan even though CPU Basic itself has no hourly charge. CPU Basic sleeps after 48 hours of inactivity; the first visitor may wait for the container and models. Paid hardware charges for running time, including idle time, unless paused/sleeping. No GPU, upgraded CPU, storage purchase or subscription purchase is performed by the helper.

The 16 GB plan is a sensible starting hypothesis: the local 90-second validation peaked at 2.38 GiB without diarization. Cloud CPU performance, the Linux image and diarization must be measured after deployment. The app shows actual stages and elapsed time, rather than inventing an ETA.

Sources: [HF pricing](https://huggingface.co/pricing), [compute Space eligibility](https://huggingface.co/docs/hub/spaces-overview), [hardware and sleep behavior](https://huggingface.co/docs/hub/spaces-gpus), [Docker Spaces](https://huggingface.co/docs/hub/spaces-sdks-docker).

## Owner setup after cost approval

The owner approves the US$9/month plan and completes PRO checkout personally if needed. Authenticate using the official hidden-input `hf auth login` prompt in a dedicated Python 3.11 environment installed from `deployment/requirements.txt`. Never send a token in chat or put it in a URL, command argument, GitHub Actions variable, browser config or source file.

Use a repository-write credential for Space deployment. For speaker clustering, separately accept the [pyannote community-1 model conditions](https://huggingface.co/pyannote/speaker-diarization-community-1), and provide a separate read-only inference token through the host's runtime Secrets. The deployment credential must not become the server's runtime token. For a new Space, the helper enables diarization when a separately supplied `DUOWEN_INFERENCE_HF_TOKEN` is present in its environment; otherwise speakers remain unassigned. A repeat deployment without a new token preserves the existing diarization setting and Secret, and reports that their validity has not been checked.

## Reviewable deployment helper

From the repository root:

```sh
# No account access or network required: inspect the exact Docker context.
python deployment/huggingface.py prepare --output /tmp/duowen-space-review

# After the owner logs in, inspect the selected account/plan without creating anything.
python deployment/huggingface.py check

# Only after approval: create/update one CPU Basic Docker Space in that account.
python deployment/huggingface.py deploy
python deployment/huggingface.py status
```

`prepare` requires a new output directory. The helper uploads an explicit source allowlist; it excludes recordings, runtime databases, local environments, tokens and model caches. Reusing an existing Space requires verified public Docker visibility, CPU Basic hardware, one current/requested replica and no attached storage. Unknown replica schemas and sleeping instances with zero active replicas are refused; review/wake the Space rather than assuming its configuration. The returned Space host is the source of truth for the backend URL; do not guess it from the username.

Offline deployment checks: `python -B -m unittest discover -s deployment/tests -v`. These mock the Hub API and do not read credentials, inspect an account or create resources.

## Release checks

1. Wait for the Linux Docker image to build. The dependency set was resolved on this Mac, but the Docker image has not yet been built or run here.
2. Verify `/api/health` and preflight CORS from `https://toooonyliu.github.io`. Check that the HF proxy passes the per-job `Authorization: Bearer` header on GET and DELETE.
3. Upload a new audio/video file through the frontend, read actual timestamped results, reload during processing, cancel a second task and confirm a decoder failure is actionable. If model access is authorized, test at least two real speakers and label the output as editable voice clusters.
4. Set the GitHub repository Actions variable `TRANSCRIPTION_API_URL` to the verified HTTPS Space origin, without `/api` or credentials. Publish the tested branch to `main`; verify the resulting public Pages flow.

## Storage boundary

CPU Basic includes non-persistent disk. The single-container SQLite database retains server-side results for up to 24 hours, but replacement/rebuild of that container can erase tasks earlier. The app retains completed transcripts in the visitor's browser; interrupted or missing server jobs need a clear retry. Input audio and decoded intermediates are removed after terminal processing. No cross-device library sync is promised.

Do not put SQLite on a bucket/FUSE mount and assume transactional locking or durability. A durable multi-instance service needs a separate database/object-store design. This proposal intentionally includes no storage add-on.
