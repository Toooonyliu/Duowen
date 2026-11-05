"""Real HTTP/SQLite/process lifecycle tests. Native ASR is tested separately."""
from dataclasses import replace
import asyncio
import hashlib
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import time
import unittest

from fastapi.testclient import TestClient
from backend.api import create_app, UploadGuard
from backend.settings import Settings
from backend.store import Store

FIXTURE = Path(__file__).with_name("fake_worker.py")


def fixture_command(folder):
    return [sys.executable, str(FIXTURE), str(folder)]


def slow_command(folder):
    return [sys.executable, str(FIXTURE), str(folder), "slow"]


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.settings = replace(Settings(), data_dir=Path(self.tmp.name), requests_per_hour=50, max_upload_bytes=1024)

    def tearDown(self):
        self.tmp.cleanup()

    def upload(self, client, body=b"fixture media", filename="meeting.wav"):
        response = client.post("/api/jobs", files={"file": (filename, body, "audio/wav")})
        self.assertEqual(response.status_code, 202, response.text)
        return response.json()

    @staticmethod
    def auth(job):
        return {"Authorization": "Bearer " + job["accessToken"]}

    def wait(self, client, job, desired="completed"):
        started = time.monotonic()
        while time.monotonic() - started < 4:
            response = client.get("/api/jobs/" + job["id"], headers=self.auth(job))
            self.assertEqual(response.status_code, 200, response.text)
            state = response.json()
            if state["status"] == desired:
                return state
            if desired == "processing" and state["stage"] == "transcribing":
                return state
            time.sleep(.02)
        self.fail(f"Task did not become {desired}: {state}")

    def test_owner_capability_result_persistence_and_media_cleanup(self):
        app = create_app(self.settings, fixture_command)
        with TestClient(app) as client:
            job = self.upload(client, filename="../../meeting.wav")
            self.assertEqual(client.get("/api/jobs/" + job["id"]).status_code, 401)
            self.assertEqual(client.get("/api/jobs/" + job["id"], headers={"Authorization": "Bearer wrong"}).status_code, 404)
            state = self.wait(client, job)
            self.assertEqual(state["result"]["segments"][0]["text"], "Queue fixture result")
            self.assertNotIn("accessToken", state)
            self.assertNotIn("token_hash", state)
            raw = app.state.store.get(job["id"])
            self.assertEqual(raw["filename"], "meeting.wav")
            self.assertEqual(raw["token_hash"], hashlib.sha256(job["accessToken"].encode()).hexdigest())
            self.assertNotIn(job["accessToken"], json.dumps(raw))
            time.sleep(.05)
            self.assertFalse((Path(self.tmp.name) / "jobs" / job["id"] / "source").exists())
        with TestClient(create_app(self.settings, fixture_command)) as client:
            state = client.get("/api/jobs/" + job["id"], headers=self.auth(job)).json()
            self.assertEqual(state["status"], "completed")
            self.assertEqual(client.delete("/api/jobs/" + job["id"], headers={"Authorization": "Bearer wrong"}).status_code, 404)
            self.assertEqual(client.delete("/api/jobs/" + job["id"], headers=self.auth(job)).json()["status"], "deleted")
            self.assertEqual(client.get("/api/jobs/" + job["id"], headers=self.auth(job)).status_code, 404)

    def test_unacknowledged_upload_never_starts_inference(self):
        with TestClient(create_app(self.settings, fixture_command)) as client:
            job = self.upload(client)
            time.sleep(.3)
            self.assertEqual(client.app.state.store.get(job["id"])["status"], "queued")
            self.wait(client, job)

    def test_running_cancel_stops_process_and_removes_media(self):
        with TestClient(create_app(self.settings, slow_command)) as client:
            job = self.upload(client)
            self.wait(client, job, "processing")
            response = client.delete("/api/jobs/" + job["id"], headers=self.auth(job))
            self.assertIn(response.json()["status"], ["cancelling", "cancelled"])
            state = self.wait(client, job, "cancelled")
            self.assertNotIn("result", state)
            time.sleep(.05)
            self.assertFalse((Path(self.tmp.name) / "jobs" / job["id"] / "source").exists())

    def test_limits_and_cors(self):
        settings = replace(self.settings, requests_per_hour=2, max_pending=1)
        with TestClient(create_app(settings, fixture_command)) as client:
            first = self.upload(client)
            self.assertEqual(client.post("/api/jobs", files={"file": ("second.wav", b"media")}).status_code, 429)
            self.assertEqual(client.post("/api/jobs", files={"file": ("third.wav", b"media")}).status_code, 429)
            response = client.get("/api/health", headers={"Origin": "https://toooonyliu.github.io"})
            self.assertEqual(response.headers["access-control-allow-origin"], "https://toooonyliu.github.io")
            response = client.get("/api/health", headers={"Origin": "https://unrelated.example"})
            self.assertNotIn("access-control-allow-origin", response.headers)
            client.delete("/api/jobs/" + first["id"], headers=self.auth(first))
        with TestClient(create_app(self.settings, fixture_command)) as client:
            response = client.post("/api/jobs", files={"file": ("large.wav", b"0" * 1200)})
            self.assertEqual(response.status_code, 413)
            response = client.post("/api/jobs", files={"file": ("body.wav", b"0" * 70000)})
            self.assertEqual(response.status_code, 413)
            self.assertEqual(client.post("/api/jobs", files={"file": ("script.exe", b"media")}).status_code, 415)
            self.assertEqual(client.post("/api/jobs", files={"file": ("empty.wav", b"")}).status_code, 400)

    def test_restart_marks_incomplete_native_job_as_interrupted(self):
        store = Store(self.settings.data_dir)
        store.add("a" * 32, "secret", "meeting.wav", 4)
        store.acknowledge("a" * 32)
        self.assertEqual(store.claim(), "a" * 32)
        with TestClient(create_app(self.settings, fixture_command)) as client:
            response = client.get("/api/jobs/" + "a" * 32, headers={"Authorization": "Bearer secret"})
            self.assertEqual(response.json()["status"], "failed")
            self.assertIn("restarted", response.json()["error"])

    def test_worker_deadline_returns_recoverable_failure(self):
        settings = replace(self.settings, job_timeout=.25)
        with TestClient(create_app(settings, slow_command)) as client:
            job = self.upload(client)
            state = self.wait(client, job, "failed")
            self.assertIn("time limit", state["error"])
            self.assertNotIn("result", state)

    def test_inflight_upload_reserves_capacity_before_multipart_body(self):
        async def scenario():
            entered, release = asyncio.Event(), asyncio.Event()
            first_messages, denied_messages = [], []

            async def body():
                entered.set()
                await release.wait()
                return {"type": "http.request", "body": b"media", "more_body": False}

            async def no_body():
                raise AssertionError("A denied upload must not read or spool its body")

            async def app(scope, receive, send):
                await receive()
                await send({"type": "http.response.start", "status": 202, "headers": []})
                await send({"type": "http.response.body", "body": b"{}"})

            async def first_send(message):
                first_messages.append(message)

            async def denied_send(message):
                denied_messages.append(message)

            scope = {"type": "http", "method": "POST", "path": "/api/jobs", "headers": [], "client": ("first", 1)}
            settings = replace(self.settings, max_pending=1)
            gate = UploadGuard(app, settings, Store(settings.data_dir))
            running = asyncio.create_task(gate(scope, body, first_send))
            await entered.wait()
            await gate({**scope, "client": ("second", 1)}, no_body, denied_send)
            self.assertEqual(denied_messages[0]["status"], 429)
            release.set()
            await running
            self.assertEqual(first_messages[0]["status"], 202)
            self.assertEqual(gate.inflight, 0)
        asyncio.run(scenario())

    def test_owner_alignment_language_environment_reaches_worker(self):
        output = subprocess.check_output(
            [sys.executable, "-c", "from backend.settings import Settings; import json; print(json.dumps(Settings().worker_config()['alignLanguages']))"],
            env={**os.environ, "DUOWEN_ALIGN_LANGUAGES": " en, ZH, fr, "}, text=True)
        self.assertEqual(json.loads(output), ["en", "zh", "fr"])


if __name__ == "__main__":
    unittest.main()
