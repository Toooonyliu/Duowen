"""Run with one ASGI worker: python -m uvicorn backend.api:app --port 8000."""
from contextlib import asynccontextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import subprocess
import threading
import time

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .settings import Settings
from .store import CapacityError, Store, TERMINAL


class UploadTooLarge(Exception):
    pass


class UploadGuard:
    """Reject oversized/rate-limited bodies before multipart parsing spools them."""
    def __init__(self, app, settings, store):
        self.app, self.settings, self.store = app, settings, store
        self.admission_lock = threading.Lock()
        self.inflight = 0

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST" or scope["path"] != "/api/jobs":
            return await self.app(scope, receive, send)
        limit = self.settings.max_upload_bytes + 65536  # Multipart envelope allowance.
        headers = dict(scope.get("headers", []))
        try:
            declared = int(headers.get(b"content-length", b"0"))
        except ValueError:
            declared = 0
        if declared > limit:
            return await JSONResponse({"detail": "This file is larger than the upload limit."}, 413)(scope, receive, send)
        # Do not trust arbitrary X-Forwarded-For; the ASGI proxy allowlist sets client.
        client = str((scope.get("client") or ("unknown",))[0])
        if not self.store.rate_allowed(client, self.settings.requests_per_hour):
            return await JSONResponse({"detail": "Upload limit reached. Please try again later."}, 429, headers={"Retry-After": "3600"})(scope, receive, send)
        with self.admission_lock:
            admitted = self.store.pending_count() + self.inflight < self.settings.max_pending
            if admitted:
                self.inflight += 1
        if not admitted:
            return await JSONResponse({"detail": "The transcription queue is full. Please retry shortly."}, 429, headers={"Retry-After": "30"})(scope, receive, send)
        consumed, started = 0, False

        async def bounded_receive():
            nonlocal consumed
            message = await receive()
            if message["type"] == "http.request":
                consumed += len(message.get("body", b""))
                if consumed > limit:
                    raise UploadTooLarge()
            return message

        async def tracked_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, bounded_receive, tracked_send)
        except UploadTooLarge:
            if not started:
                await JSONResponse({"detail": "This file is larger than the upload limit."}, 413)(scope, receive, send)
        finally:
            with self.admission_lock:
                self.inflight -= 1


def stop_process(process):
    if process and process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=3)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=3)


class Supervisor:
    """One durable queue, one disposable native inference process at a time."""
    def __init__(self, settings, store, command=None):
        self.settings, self.store = settings, store
        self.command = command
        self.stop_event = threading.Event()
        self.wake = threading.Event()
        self.process = None
        self.thread = None
        self.lock = None

    def start(self):
        self.lock = (self.store.folder / ".service.lock").open("a+")
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            self.lock.close()
            raise RuntimeError("Duowen requires exactly one ASGI worker/replica for this SQLite queue.") from error
        self.store.recover()
        self.thread = threading.Thread(target=self.loop, name="whisperx-queue", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.wake.set()
        if self.thread:
            self.thread.join(timeout=6)
        stop_process(self.process)
        if self.lock:
            self.lock.close()

    def purge(self, job_id):
        shutil.rmtree(self.store.folder / "jobs" / job_id, ignore_errors=True)
        self.store.delete(job_id)

    def loop(self):
        while not self.stop_event.is_set():
            # No CPU work until the visitor proves receipt of the private job token.
            for job_id in self.store.abandoned(time.time() - 120):
                self.purge(job_id)
            for job_id in self.store.expired(time.time() - self.settings.retention_seconds):
                self.purge(job_id)
            job_id = self.store.claim()
            if job_id:
                try:
                    self.run_job(job_id)
                except Exception:
                    # Never return native stderr, local paths or credentials to visitors.
                    stop_process(self.process)
                    self.store.update(job_id, status="failed", stage="failed", percent=None,
                                      error="The transcription worker could not finish. Please retry.", detail="Transcription failed")
                    self.clean_inputs(job_id)
            else:
                self.wake.wait(timeout=1)
                self.wake.clear()

    def clean_inputs(self, job_id):
        folder = self.store.folder / "jobs" / job_id
        # Also remove a partially written atomic .tmp file after cancellation.
        shutil.rmtree(folder, ignore_errors=True)

    def run_job(self, job_id):
        folder = self.store.folder / "jobs" / job_id
        command = self.command(folder) if self.command else [self.settings.inference_python, "-m", "backend.worker", "--job-dir", str(folder)]
        started, last_revision = time.monotonic(), None
        with (folder / "worker.log").open("wb") as log:
            self.process = subprocess.Popen(command, cwd=Path(__file__).resolve().parent.parent,
                                            stdout=log, stderr=log, start_new_session=True)
            cancelled, timed_out = False, False
            while self.process.poll() is None:
                job = self.store.get(job_id)
                cancelled = bool(job and job["cancel_requested"])
                timed_out = time.monotonic() - started > self.settings.job_timeout
                if cancelled or timed_out or self.stop_event.is_set():
                    stop_process(self.process)
                    break
                try:
                    event = json.loads((folder / "progress.json").read_text())
                    if event.get("revision") != last_revision:
                        last_revision = event.get("revision")
                        self.store.update(job_id, stage=event["stage"], percent=event.get("percent"), detail=event.get("detail", "Processing audio"))
                except (OSError, ValueError, KeyError):
                    pass
                self.stop_event.wait(.2)
            cancelled = cancelled or bool((self.store.get(job_id) or {}).get("cancel_requested"))
            if cancelled:
                self.store.update(job_id, status="cancelled", stage="cancelled", percent=None, detail="Transcription cancelled")
            elif self.stop_event.is_set():
                self.store.update(job_id, status="failed", stage="failed", percent=None, error="Processing was interrupted by a server restart. Please upload the recording again.", detail="Processing interrupted")
            elif timed_out:
                self.store.update(job_id, status="failed", stage="failed", percent=None, error="This recording exceeded the server's processing time limit. Please try a shorter recording.", detail="Processing time limit reached")
            else:
                try:
                    outcome = json.loads((folder / "result.json").read_text())
                    if self.process.returncode != 0 or not outcome.get("ok"):
                        raise ValueError(outcome.get("error", "Transcription failed. Please retry."))
                    self.store.update(job_id, status="completed", stage="completed", percent=100,
                                      detail="Transcript ready", result=json.dumps(outcome["result"], ensure_ascii=False, allow_nan=False))
                except (OSError, ValueError, KeyError) as error:
                    message = str(error) if isinstance(error, ValueError) else "The transcription process stopped unexpectedly. Please retry."
                    self.store.update(job_id, status="failed", stage="failed", percent=None, error=message, detail="Transcription failed")
        self.process = None
        # The completed result lives in SQLite, not in the process memory or media folder.
        self.clean_inputs(job_id)


def create_app(settings=None, worker_command=None):
    settings = settings or Settings()
    store = Store(settings.data_dir)
    supervisor = Supervisor(settings, store, worker_command)

    @asynccontextmanager
    async def lifespan(app):
        supervisor.start()
        yield
        supervisor.stop()

    app = FastAPI(title="Duowen WhisperX", docs_url=None, redoc_url=None, lifespan=lifespan)
    app.state.store, app.state.supervisor = store, supervisor
    app.add_middleware(UploadGuard, settings=settings, store=store)
    app.add_middleware(CORSMiddleware, allow_origins=list(settings.allowed_origins), allow_credentials=False,
                       allow_methods=["GET", "POST", "DELETE", "OPTIONS"], allow_headers=["Content-Type", "Authorization"])

    def owned(job_id, request):
        if not re.fullmatch(r"[a-f0-9]{32}", job_id):
            raise HTTPException(404, "Recording task not found.")
        header = request.headers.get("authorization", "")
        if not header.startswith("Bearer "):
            raise HTTPException(401, "This task requires its private access token.", headers={"WWW-Authenticate": "Bearer"})
        job = store.owned(job_id, header[7:])
        if not job:
            raise HTTPException(404, "Recording task not found.")
        return job

    @app.get("/api/health")
    def health():
        return {"status": "ok", "engine": "whisperx", "acceptingJobs": store.pending_count() < settings.max_pending}

    @app.post("/api/jobs", status_code=202)
    async def upload(request: Request, file: UploadFile = File(...), language: str = Form("auto")):
        if language != "auto" and not re.fullmatch(r"[a-z]{2,3}", language):
            raise HTTPException(400, "Use a language code such as en or zh, or auto.")
        filename = (file.filename or "recording").replace("\\", "/").split("/")[-1][:200]
        allowed = {".mp3", ".m4a", ".wav", ".mp4", ".mov", ".ogg", ".opus", ".aac", ".flac", ".webm", ".mpeg", ".mpga", ".aiff", ".aif", ".mkv"}
        if Path(filename).suffix.lower() not in allowed:
            raise HTTPException(415, "Choose an audio or video file.")
        used = sum(p.stat().st_size for p in store.folder.rglob("*") if p.is_file())
        if used + settings.max_upload_bytes > settings.max_storage_bytes:
            raise HTTPException(503, "The transcription server is temporarily out of storage. Please retry later.")
        job_id, token = secrets.token_hex(16), secrets.token_urlsafe(32)
        folder = store.folder / "jobs" / job_id
        folder.mkdir(parents=True, mode=0o700)
        written = 0
        try:
            with (folder / "source").open("xb") as handle:
                while chunk := await file.read(1024 * 1024):
                    written += len(chunk)
                    if written > settings.max_upload_bytes:
                        raise HTTPException(413, "This file is larger than the upload limit.")
                    handle.write(chunk)
            if not written:
                raise HTTPException(400, "The selected file is empty.")
            (folder / "config.json").write_text(json.dumps({**settings.worker_config(), "language": language}))
            if await request.is_disconnected():
                raise HTTPException(400, "The upload was cancelled.")
            try:
                store.add(job_id, token, filename, settings.max_pending)
            except CapacityError:
                raise HTTPException(429, "The transcription queue is full. Please retry shortly.", headers={"Retry-After": "30"})
        except BaseException:
            shutil.rmtree(folder, ignore_errors=True)
            raise
        finally:
            await file.close()
        supervisor.wake.set()
        return {"id": job_id, "accessToken": token, "status": "queued", "stage": "queued", "percent": None}

    @app.get("/api/jobs/{job_id}")
    def get_job(job_id: str, request: Request):
        job = owned(job_id, request)
        if job["status"] == "queued" and not job["acknowledged"]:
            store.acknowledge(job_id)
            supervisor.wake.set()
        return store.public(job)

    @app.delete("/api/jobs/{job_id}")
    def cancel_job(job_id: str, request: Request):
        job = owned(job_id, request)
        if job["status"] in TERMINAL:
            supervisor.purge(job_id)
            return {"id": job_id, "status": "deleted"}
        status = store.request_cancel(job_id)
        if status in TERMINAL and status != "cancelled":
            supervisor.purge(job_id)
            return {"id": job_id, "status": "deleted"}
        if status == "cancelled":
            supervisor.clean_inputs(job_id)
        supervisor.wake.set()
        return {"id": job_id, "status": status}

    return app


app = create_app()
