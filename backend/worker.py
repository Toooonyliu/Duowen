"""A disposable WhisperX process; reports real stages via atomically written files."""
import argparse
import copy
import gc
import inspect
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import time
import wave


def write_json(path, data):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, allow_nan=False))
    temporary.replace(path)


def finite(value):
    return isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value)


def run(folder):
    config = json.loads((folder / "config.json").read_text())
    revision = 0

    def progress(stage, detail, percent=None):
        nonlocal revision
        revision += 1
        if percent is not None:
            percent = min(100, max(0, float(percent)))
        write_json(folder / "progress.json", {"revision": revision, "stage": stage, "detail": detail, "percent": percent})

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("Audio decoding is not installed on the transcription server.")
    progress("decoding", "Reading the recording's audio track")
    decoded = folder / "decoded.wav"
    try:
        # A decode limit also bounds malformed/stream-like media without duration metadata.
        subprocess.run([ffmpeg, "-nostdin", "-v", "error", "-i", str(folder / "source"),
                        "-map", "0:a:0", "-vn", "-t", str(config["maxDuration"] + 1),
                        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(decoded)],
                       check=True, capture_output=True, timeout=120)
        with wave.open(str(decoded)) as audio_file:
            duration = audio_file.getnframes() / audio_file.getframerate()
    except (subprocess.SubprocessError, OSError, wave.Error):
        raise ValueError("This recording could not be decoded. Please try an MP3, WAV, M4A or a video with an audio track.") from None
    if duration <= .05:
        raise ValueError("The recording contains no usable audio.")
    if duration > config["maxDuration"] + .05:
        raise ValueError(f"This recording is longer than the server's {config['maxDuration'] // 60}-minute limit. Please use a shorter excerpt.")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    progress("model-loading", "Loading WhisperX; the first recording may need a model download")
    try:
        import whisperx
        from whisperx.asr import load_model
    except Exception:
        raise RuntimeError("WhisperX is not available on this server. Please contact the site owner.") from None
    audio = whisperx.load_audio(str(decoded))
    language = None if config.get("language", "auto") == "auto" else config["language"]
    options = {"compute_type": config["computeType"], "language": language}
    if "vad_method" in inspect.signature(load_model).parameters:
        options["vad_method"] = "silero"
    try:
        model = load_model(config["model"], config["device"], **options)
        kwargs = {"batch_size": config["batchSize"], "language": language}
        if "progress_callback" in inspect.signature(model.transcribe).parameters:
            kwargs["progress_callback"] = lambda pct: progress("transcribing", "Transcribing the recording", pct)
        progress("transcribing", "Transcribing the recording")
        result = model.transcribe(audio, **kwargs)
    except Exception:
        raise RuntimeError("WhisperX could not transcribe this recording. Model loading may require a connection; please retry.") from None
    finally:
        if "model" in locals():
            del model
        gc.collect()
        if config["device"] == "cuda":
            import torch
            torch.cuda.empty_cache()
    if not result.get("segments"):
        raise ValueError("No speech was detected in this recording. Try a clearer recording or a different language setting.")
    language = result["language"]
    timing_source = "asr-segment-approximate"
    alignment_status = "not-run"
    notes = ["Automatic transcript; names, wording and timestamps should be reviewed against the audio."]
    if config.get("align") and language in config.get("alignLanguages", ["en", "zh"]):
        progress("aligning", "Aligning transcript timestamps to the audio")
        try:
            aligner, metadata = whisperx.load_align_model(language_code=language, device=config["device"])
            kwargs = {"return_char_alignments": False}
            if "progress_callback" in inspect.signature(whisperx.align).parameters:
                kwargs["progress_callback"] = lambda pct: progress("aligning", "Aligning transcript timestamps", pct)
            aligned = whisperx.align(copy.deepcopy(result["segments"]), aligner, metadata, audio, config["device"], **kwargs)
            if aligned.get("segments"):
                aligned["language"] = language
                result = aligned
                timing_source, alignment_status = "whisperx-forced-alignment-unreviewed", "completed"
        except Exception:
            alignment_status = "failed"
            notes.append("Word alignment was unavailable; approximate ASR segment timestamps were retained.")
        finally:
            if "aligner" in locals():
                del aligner
            gc.collect()
            if config["device"] == "cuda":
                import torch
                torch.cuda.empty_cache()
    elif config.get("align"):
        notes.append("Word alignment is not configured for this language; approximate ASR segment timestamps were retained.")
    diarization_status = "not-run"
    token = os.getenv("HF_TOKEN")
    if config.get("diarize") and token:
        progress("diarizing", "Separating speakers; labels are voice clusters, not verified names")
        try:
            from whisperx.diarize import DiarizationPipeline
            auth_field = "token" if "token" in inspect.signature(DiarizationPipeline).parameters else "use_auth_token"
            diarizer = DiarizationPipeline(device=config["device"], **{auth_field: token})
            kwargs = {}
            if "progress_callback" in inspect.signature(diarizer.__call__).parameters:
                kwargs["progress_callback"] = lambda pct: progress("diarizing", "Separating speakers", pct)
            frames = diarizer(audio, **kwargs)
            result = whisperx.assign_word_speakers(frames, result, fill_nearest=False)
            diarization_status = "completed"
        except Exception:
            diarization_status = "failed"
            notes.append("Speaker separation could not complete. Unassigned segments are left as Unknown speaker.")
        finally:
            if "diarizer" in locals():
                del diarizer
            gc.collect()
    elif config.get("diarize"):
        notes.append("Speaker separation was not run because the server has no authorized Hugging Face model token.")
    segments, speaker_ids = [], []
    for item in result.get("segments", []):
        body = str(item.get("text", "")).strip()
        if not body:
            continue
        start, end = item.get("start"), item.get("end")
        if not finite(start) or not finite(end) or end < start:
            start = end = None
        else:
            start, end = max(0, min(float(start), duration)), max(0, min(float(end), duration))
        speaker = str(item.get("speaker") or "unassigned")
        if speaker not in speaker_ids:
            speaker_ids.append(speaker)
        segments.append({"start": start, "end": end, "text": body, "speakerId": speaker})
    if not segments:
        raise ValueError("No speech was detected in this recording. Please try a clearer recording.")
    speakers = [{"id": speaker, "name": "Unknown speaker" if speaker == "unassigned" else f"Speaker {index + 1}",
                 "confirmed": False} for index, speaker in enumerate(speaker_ids)]
    return {"segments": segments, "speakers": speakers, "language": language, "duration": duration,
            "timingSource": timing_source, "alignmentStatus": alignment_status,
            "diarizationStatus": diarization_status, "engine": "whisperx", "model": config["model"],
            "reviewStatus": "uncorrected-asr", "notes": notes}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-dir", type=Path, required=True)
    folder = parser.parse_args().job_dir
    started = time.monotonic()
    try:
        result = run(folder)
        result["processingSeconds"] = round(time.monotonic() - started, 3)
        write_json(folder / "result.json", {"ok": True, "result": result})
        return 0
    except (ValueError, RuntimeError) as error:
        # Messages above are controlled product copy, never raw exception bodies.
        write_json(folder / "result.json", {"ok": False, "error": str(error)})
        return 1
    except Exception:
        write_json(folder / "result.json", {"ok": False, "error": "The transcription worker encountered an unexpected problem. Please retry."})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
