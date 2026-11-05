from dataclasses import dataclass
import os
from pathlib import Path
import sys


@dataclass(frozen=True)
class Settings:
    data_dir: Path = Path(os.getenv("DUOWEN_DATA_DIR", "backend/.runtime"))
    inference_python: str = os.getenv("DUOWEN_INFERENCE_PYTHON", sys.executable)
    allowed_origins: tuple = tuple(filter(None, os.getenv(
        "DUOWEN_ALLOWED_ORIGINS", "https://toooonyliu.github.io,http://127.0.0.1:4173,http://127.0.0.1:4174,http://127.0.0.1:4175"
    ).split(",")))
    max_upload_bytes: int = int(os.getenv("DUOWEN_MAX_UPLOAD_MB", "100")) * 1024 * 1024
    max_duration: int = int(os.getenv("DUOWEN_MAX_DURATION_SECONDS", "1800"))
    max_pending: int = int(os.getenv("DUOWEN_MAX_PENDING_JOBS", "4"))
    requests_per_hour: int = int(os.getenv("DUOWEN_UPLOADS_PER_IP_HOUR", "5"))
    retention_seconds: int = int(os.getenv("DUOWEN_RETENTION_SECONDS", "86400"))
    job_timeout: int = int(os.getenv("DUOWEN_JOB_TIMEOUT_SECONDS", "1800"))
    max_storage_bytes: int = int(os.getenv("DUOWEN_MAX_STORAGE_MB", "2048")) * 1024 * 1024
    model: str = os.getenv("DUOWEN_WHISPER_MODEL", "base")
    device: str = os.getenv("DUOWEN_DEVICE", "cpu")
    compute_type: str = os.getenv("DUOWEN_COMPUTE_TYPE", "int8")
    batch_size: int = int(os.getenv("DUOWEN_BATCH_SIZE", "1"))
    align: bool = os.getenv("DUOWEN_ALIGN", "1") == "1"
    align_languages: tuple = tuple(value.strip().lower() for value in os.getenv(
        "DUOWEN_ALIGN_LANGUAGES", "en,zh").split(",") if value.strip())
    diarize: bool = os.getenv("DUOWEN_DIARIZE", "0") == "1"

    def worker_config(self):
        return {"model": self.model, "device": self.device, "computeType": self.compute_type,
                "batchSize": self.batch_size, "align": self.align, "alignLanguages": self.align_languages, "diarize": self.diarize,
                "maxDuration": self.max_duration}
