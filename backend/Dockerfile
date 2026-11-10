FROM python:3.11-slim-bookworm
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 HF_HUB_DISABLE_TELEMETRY=1 TOKENIZERS_PARALLELISM=false
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg libgomp1 \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/nemo /opt/models \
    && curl -fsSL --retry 3 -o /tmp/nemo.tar.gz https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.3.0/nemo-speech-0.3.0-linux-x86_64-cpu.tar.gz \
    && echo '255f12b722ab15b2a38a51cf125d56e3fa97058b528f7e895b39d6a473deb06e  /tmp/nemo.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/nemo.tar.gz -C /opt/nemo --strip-components=1 \
    && rm /tmp/nemo.tar.gz \
    && curl -fsSL --retry 3 -o /opt/models/nemotron-3-diarization.gguf https://huggingface.co/nvidia/Nemotron-3-Diarization/resolve/f667ed73aee57d40cc39428eb768b4fd87a0a29e/Nemotron-3-Diarization.q8_0.gguf \
    && echo '08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1  /opt/models/nemotron-3-diarization.gguf' | sha256sum -c -
WORKDIR /app
COPY requirements-api.txt requirements-cpu.txt /app/backend/
RUN pip install torch==2.8.0 torchaudio==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cpu \
    && pip install -r /app/backend/requirements-cpu.txt
RUN useradd --uid 1000 --create-home appuser && mkdir -p /data/duowen /home/appuser/.cache \
    && chown -R appuser:appuser /data /home/appuser
COPY --chown=appuser:appuser . /app/backend
USER appuser
ENV DUOWEN_DATA_DIR=/data/duowen DUOWEN_DEVICE=cpu DUOWEN_COMPUTE_TYPE=int8
ENV DUOWEN_DIARIZE=1 \
    DUOWEN_NEMO_SPEECH_BIN=/opt/nemo/bin/nemo-speech \
    DUOWEN_NEMO_DIARIZATION_MODEL=/opt/models/nemotron-3-diarization.gguf
RUN "$DUOWEN_NEMO_SPEECH_BIN" help diarize >/dev/null
EXPOSE 7860
# Keep one worker/one replica: SQLite and native inference share this persistent disk.
CMD ["sh", "-c", "exec uvicorn backend.api:app --host 0.0.0.0 --port ${PORT:-7860} --workers 1 --no-access-log"]
