"""Upload an actual recording and verify a real WhisperX result. Never prints job tokens."""
import argparse
import json
from pathlib import Path
import time
import httpx

parser = argparse.ArgumentParser()
parser.add_argument("--url", default="http://127.0.0.1:8000")
parser.add_argument("--audio", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--contains", action="append", default=[])
args = parser.parse_args()
started = time.monotonic()
with httpx.Client(timeout=120) as client:
    with args.audio.open("rb") as handle:
        response = client.post(args.url.rstrip("/") + "/api/jobs", files={"file": (args.audio.name, handle)})
    response.raise_for_status()
    job = response.json()
    headers = {"Authorization": "Bearer " + job["accessToken"]}
    url = args.url.rstrip("/") + "/api/jobs/" + job["id"]
    previous = None
    while time.monotonic() - started < 1800:
        response = client.get(url, headers=headers)
        response.raise_for_status()
        state = response.json()
        if state["stage"] != previous:
            print(state["stage"], flush=True)
            previous = state["stage"]
        if state["status"] == "completed":
            result = state["result"]
            text = " ".join(segment["text"] for segment in result["segments"]).casefold()
            assert result["engine"] == "whisperx"
            for expected in args.contains:
                assert expected.casefold() in text, f"Expected phrase missing: {expected}"
            assert result["segments"] and all(s["start"] is not None and s["end"] >= s["start"] for s in result["segments"])
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps({"elapsedSeconds": time.monotonic() - started, "result": result}, ensure_ascii=False, indent=2))
            print(f"PASS: {len(result['segments'])} real segments; {time.monotonic() - started:.2f}s; result saved to {args.output}")
            break
        if state["status"] in ("failed", "cancelled"):
            raise RuntimeError(state.get("error", state["status"]))
        time.sleep(.5)
    else:
        client.delete(url, headers=headers)
        raise TimeoutError("WhisperX smoke test exceeded 30 minutes and was cancelled")
