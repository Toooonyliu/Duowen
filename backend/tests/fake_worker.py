"""Queue protocol fixture only. This file is never an ASR accuracy test."""
import json
from pathlib import Path
import sys
import time

folder = Path(sys.argv[1])
mode = sys.argv[2] if len(sys.argv) > 2 else "complete"
for revision, stage in enumerate(("model-loading", "transcribing", "aligning"), 1):
    pending = folder / "progress.tmp"
    pending.write_text(json.dumps({"revision": revision, "stage": stage, "detail": stage, "percent": None}))
    pending.replace(folder / "progress.json")
    time.sleep(.06)
    if mode == "slow" and stage == "transcribing":
        time.sleep(30)
result = {"segments": [{"start": .1, "end": 1.2, "text": "Queue fixture result", "speakerId": "unassigned"}],
          "speakers": [{"id": "unassigned", "name": "Unknown speaker", "confirmed": False}],
          "engine": "queue-test-fixture", "duration": 2, "diarizationStatus": "not-run"}
(folder / "result.json").write_text(json.dumps({"ok": True, "result": result}))
