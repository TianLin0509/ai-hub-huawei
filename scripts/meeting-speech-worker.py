"""Local CPU transcription for meetings (SenseVoice via sherpa-onnx); stdout is a JSON-lines protocol.

Request:  {"id": 1, "file": "x.wav", "voiceprint": true}
Response: {"id": 1, "segments": [{"start": 0.0, "end": 2.1, "text": "...", "voice": [..192 floats..]}]}
Sentences are cut at sentence punctuation or long pauses, so each line in the transcript is one utterance.
"""
import json
import os
import sys
import wave

import numpy as np
import sherpa_onnx

sys.stdout.reconfigure(encoding="utf-8")
sys.stdin.reconfigure(encoding="utf-8")
ROOT = sys.argv[1]
THREADS = int(os.environ.get("MEETING_ASR_THREADS", "2"))
recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
    model=os.path.join(ROOT, "model.int8.onnx"), tokens=os.path.join(ROOT, "tokens.txt"),
    num_threads=THREADS, use_itn=True, language="auto")
voice_model = os.path.join(ROOT, "voiceprint.onnx")
extractor = None
if os.path.exists(voice_model):
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=voice_model, num_threads=1))

END = set("。？！?!")
SOFT = set("，,；;")
FILLER = {"嗯", "啊", "呃", "哦", "额", "yeah", "the", "嗯嗯", "啊啊", "okay", "ok", "yes", "uh", "um", "i"}
TAIL = 0.25


def read(path):
    with wave.open(path, "rb") as source:
        if source.getsampwidth() != 2:
            raise ValueError("Expected PCM16 WAV")
        rate = source.getframerate()
        samples = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
        samples = samples.reshape(-1, source.getnchannels()).mean(axis=1)
    if rate != 16000:
        samples = np.interp(np.arange(round(len(samples) * 16000 / rate)) * rate / 16000, np.arange(len(samples)), samples).astype(np.float32)
    return samples


def sentences(tokens, stamps, total):
    """Group tokens into utterances: end punctuation, a pause over 0.8 s, or a comma once a line passes 12 s."""
    out, cur, start = [], "", None
    for i, (tok, at) in enumerate(zip(tokens, stamps)):
        if start is None:
            start = at
        nxt = stamps[i + 1] if i + 1 < len(stamps) else None
        cur += tok
        pause = nxt is not None and nxt - at > 0.8
        long_line = at - start > 12 and tok in SOFT
        if tok in END or pause or long_line or nxt is None:
            end = min(total, (nxt if nxt is not None and not pause else at + TAIL + 0.2))
            out.append((start, max(end, start + 0.3), cur))
            cur, start = "", None
    return out


def clean(text):
    stripped = text.strip().strip("，。？！,.?! ").strip()
    return "" if stripped.lower() in FILLER else text.strip()


def voiceprint(samples, start, end):
    if extractor is None or end - start < 1.0:
        return None
    clip = samples[int(start * 16000):int(end * 16000)]
    stream = extractor.create_stream()
    stream.accept_waveform(16000, clip)
    stream.input_finished()
    vec = np.array(extractor.compute(stream), dtype=np.float32)
    norm = float(np.linalg.norm(vec))
    return [round(float(v), 4) for v in vec / norm] if norm > 0 else None


def transcribe(request):
    samples = read(request["file"])
    total = len(samples) / 16000
    if total < 0.2 or float(np.sqrt(np.mean(samples ** 2))) < 1e-4:
        return []
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, samples)
    recognizer.decode_stream(stream)
    result = stream.result
    tokens, stamps = list(result.tokens), list(result.timestamps)
    if not tokens or len(tokens) != len(stamps):
        text = clean(result.text)
        return [{"start": 0.0, "end": total, "text": text}] if text else []
    segments = []
    for start, end, text in sentences(tokens, stamps, total):
        text = clean(text)
        if not text:
            continue
        item = {"start": round(start, 2), "end": round(end, 2), "text": text}
        if request.get("voiceprint"):
            vec = voiceprint(samples, start, end)
            if vec:
                item["voice"] = vec
        segments.append(item)
    return segments


print(json.dumps({"event": "ready", "engine": "sensevoice", "voiceprint": extractor is not None}), flush=True)
for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        print(json.dumps({"id": request["id"], "segments": transcribe(request)}, ensure_ascii=False), flush=True)
    except Exception as exc:  # report per request; the worker keeps serving
        print(json.dumps({"id": request.get("id"), "error": str(exc)}, ensure_ascii=False), flush=True)
