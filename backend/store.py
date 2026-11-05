"""SQLite-backed queue and result ownership. No transcript or token enumeration API."""
import hashlib
import hmac
import json
from contextlib import contextmanager
from pathlib import Path
import secrets
import sqlite3
import time

TERMINAL = {"completed", "failed", "cancelled"}


class CapacityError(Exception):
    pass


class Store:
    def __init__(self, folder: Path):
        self.folder = folder.resolve()
        self.folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.folder / "jobs.sqlite3"
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, filename TEXT NOT NULL,
                    status TEXT NOT NULL, stage TEXT NOT NULL, percent REAL, detail TEXT,
                    created REAL NOT NULL, updated REAL NOT NULL, result TEXT, error TEXT,
                    cancel_requested INTEGER NOT NULL DEFAULT 0,
                    acknowledged INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS upload_rates (client TEXT NOT NULL, bucket INTEGER NOT NULL,
                    count INTEGER NOT NULL, PRIMARY KEY(client,bucket));
            """)
            columns = {row[1] for row in db.execute("PRAGMA table_info(jobs)")}
            if "acknowledged" not in columns:
                db.execute("ALTER TABLE jobs ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0")
        self.path.chmod(0o600)
        salt_file = self.folder / ".rate-salt"
        if not salt_file.exists():
            try:
                with salt_file.open("xb") as handle:
                    handle.write(secrets.token_bytes(32))
                salt_file.chmod(0o600)
            except FileExistsError:
                pass
        self.salt = salt_file.read_bytes()

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def hash_token(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def rate_allowed(self, client, maximum):
        # Only a salted digest is retained, never the user's IP address.
        client = hmac.new(self.salt, client.encode(), hashlib.sha256).hexdigest()
        bucket = int(time.time() // 3600)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM upload_rates WHERE bucket < ?", (bucket - 1,))
            row = db.execute("SELECT count FROM upload_rates WHERE client=? AND bucket=?", (client, bucket)).fetchone()
            if row and row[0] >= maximum:
                return False
            db.execute("INSERT INTO upload_rates VALUES(?,?,1) ON CONFLICT(client,bucket) DO UPDATE SET count=count+1", (client, bucket))
        return True

    def add(self, job_id, token, filename, max_pending):
        now = time.time()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            count = db.execute("SELECT count(*) FROM jobs WHERE status IN ('queued','processing')").fetchone()[0]
            if count >= max_pending:
                raise CapacityError()
            db.execute("INSERT INTO jobs(id,token_hash,filename,status,stage,detail,created,updated) VALUES(?,?,?,'queued','queued',?,?,?)",
                       (job_id, self.hash_token(token), filename, "Waiting for the transcription worker", now, now))

    def get(self, job_id):
        with self.connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        return dict(row) if row else None

    def owned(self, job_id, token):
        job = self.get(job_id)
        return job if job and hmac.compare_digest(job["token_hash"], self.hash_token(token)) else None

    def update(self, job_id, **values):
        allowed = {"status", "stage", "percent", "detail", "result", "error", "cancel_requested"}
        if not values.keys() <= allowed:
            raise ValueError("Invalid queue field")
        values["updated"] = time.time()
        with self.connect() as db:
            db.execute("UPDATE jobs SET " + ",".join(key + "=?" for key in values) + " WHERE id=?", (*values.values(), job_id))

    def claim(self):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT id FROM jobs WHERE status='queued' AND acknowledged=1 ORDER BY created LIMIT 1").fetchone()
            if row:
                db.execute("UPDATE jobs SET status='processing',stage='model-loading',percent=NULL,detail=?,updated=? WHERE id=?",
                           ("Starting WhisperX", time.time(), row[0]))
                return row[0]

    def acknowledge(self, job_id):
        with self.connect() as db:
            db.execute("UPDATE jobs SET acknowledged=1 WHERE id=? AND status='queued'", (job_id,))

    def abandoned(self, before):
        with self.connect() as db:
            return [row[0] for row in db.execute("SELECT id FROM jobs WHERE status='queued' AND acknowledged=0 AND created < ?", (before,))]

    def recover(self):
        # A crashed native inference process is not silently reported as completed.
        with self.connect() as db:
            db.execute("UPDATE jobs SET status='failed',stage='failed',percent=NULL,error=?,detail=?,updated=? WHERE status='processing'",
                       ("The transcription server restarted. Please upload this recording again.", "Processing was interrupted", time.time()))
            db.execute("UPDATE jobs SET status='cancelled',stage='cancelled',updated=? WHERE cancel_requested=1 AND status='queued'", (time.time(),))

    def pending_count(self):
        with self.connect() as db:
            return db.execute("SELECT count(*) FROM jobs WHERE status IN ('queued','processing')").fetchone()[0]

    def expired(self, before):
        with self.connect() as db:
            return [row[0] for row in db.execute("SELECT id FROM jobs WHERE status IN ('completed','failed','cancelled') AND updated < ?", (before,))]

    def delete(self, job_id):
        with self.connect() as db:
            db.execute("DELETE FROM jobs WHERE id=?", (job_id,))

    def request_cancel(self, job_id):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                return None
            status = row[0]
            if status == "queued":
                db.execute("UPDATE jobs SET status='cancelled',stage='cancelled',cancel_requested=1,detail='Transcription cancelled',updated=? WHERE id=?", (time.time(), job_id))
                return "cancelled"
            if status == "processing":
                db.execute("UPDATE jobs SET cancel_requested=1,detail='Cancelling transcription',updated=? WHERE id=?", (time.time(), job_id))
                return "cancelling"
            return status

    def public(self, job):
        result = {"id": job["id"], "status": job["status"], "stage": job["stage"],
                  "percent": job["percent"], "detail": job["detail"],
                  "createdAt": job["created"], "updatedAt": job["updated"]}
        if job["error"]:
            result["error"] = job["error"]
        if job["result"] and job["status"] == "completed":
            result["result"] = json.loads(job["result"])
        return result
