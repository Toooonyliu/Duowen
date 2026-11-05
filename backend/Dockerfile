FROM python:3.11-slim-bookworm
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 HF_HUB_DISABLE_TELEMETRY=1 TOKENIZERS_PARALLELISM=false
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgomp1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements-api.txt requirements-cpu.txt /app/backend/
RUN pip install torch==2.8.0 torchaudio==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cpu \
    && pip install -r /app/backend/requirements-cpu.txt
RUN useradd --uid 1000 --create-home appuser && mkdir -p /data/duowen /home/appuser/.cache \
    && chown -R appuser:appuser /data /home/appuser
COPY --chown=appuser:appuser . /app/backend
USER appuser
ENV DUOWEN_DATA_DIR=/data/duowen DUOWEN_DEVICE=cpu DUOWEN_COMPUTE_TYPE=int8
EXPOSE 7860
# Keep one worker/one replica: SQLite and native inference share this persistent disk.
CMD ["sh", "-c", "exec uvicorn backend.api:app --host 0.0.0.0 --port ${PORT:-7860} --workers 1 --no-access-log"]
