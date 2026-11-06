"""Opt-in real-model regression across languages, music, silence and noise.
Outputs artifacts to --output; never changes the app's profile or user subtitles.
"""

import argparse, json, sys, time, wave
from pathlib import Path
import numpy as np

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / "extraResources/python-review"))
from speech_review import review, read_audio
from review_core import normalize
from faster_whisper import WhisperModel

parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True)
parser.add_argument("--output", required=True)
parser.add_argument(
    "--cases", default="en,zh,ja,en.music,zh.music,ja.music,silence,noise,tones"
)
parser.add_argument(
    "--reuse-baselines",
    help="Replay existing first-pass outputs, avoiding unrelated model nondeterminism",
)
parser.add_argument("--threads", type=int, default=2)
args = parser.parse_args()
out = Path(args.output)
out.mkdir(parents=True, exist_ok=True)
model = WhisperModel(
    args.model,
    device="cpu",
    compute_type="auto",
    cpu_threads=args.threads,
    local_files_only=True,
)
summaries = []
for name in args.cases.split(","):
    path = root / ".longgap/audio" / f"{name}.wav"
    if name == "en.quiet":
        audio, _ = read_audio(str(root / ".longgap/audio/en.wav"))
        audio *= 0.06
        path = out / f"{name}.wav"
        with wave.open(str(path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes((audio * 32767).astype("<i2").tobytes())
    if name == "en.repeat":
        audio, _ = read_audio(str(root / ".longgap/audio/en.wav"), 0, 12)
        audio = np.concatenate(
            [
                audio,
                np.zeros(16000 * 3, dtype=np.float32),
                audio,
                np.zeros(16000 * 3, dtype=np.float32),
                audio,
            ]
        )
        path = out / f"{name}.wav"
        with wave.open(str(path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes((audio * 32767).astype("<i2").tobytes())
    if name in ["silence", "noise", "tones"]:
        n = 16000 * 12
        t = np.arange(n) / 16000
        audio = (
            np.zeros(n)
            if name == "silence"
            else (
                np.random.default_rng(42).normal(0, 0.06, n)
                if name == "noise"
                else 0.08
                * np.sin(t * 2 * np.pi * 440)
                * (0.5 + 0.5 * np.sin(t * 2 * np.pi * 3))
            )
        )
        path = out / f"{name}.wav"
        with wave.open(str(path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    print("START", name, flush=True)
    start = time.monotonic()
    saved = (
        Path(args.reuse_baselines) / f"{name}.baseline.json"
        if args.reuse_baselines
        else None
    )
    if saved and saved.exists():
        baseline = json.loads(saved.read_text())
    else:
        segs, info = model.transcribe(
            str(path),
            language=(
                name.split(".")[0] if name.split(".")[0] in ["en", "zh", "ja"] else "en"
            ),
            word_timestamps=True,
            vad_filter=True,
            vad_parameters={
                "threshold": 0.5,
                "min_speech_duration_ms": 250,
                "min_silence_duration_ms": 100,
                "speech_pad_ms": 200,
            },
        )
        baseline = {
            "language": info.language,
            "segments": [
                {
                    "start": s.start,
                    "end": s.end,
                    "text": s.text,
                    "words": [
                        {
                            "start": w.start,
                            "end": w.end,
                            "word": w.word,
                            "probability": w.probability,
                        }
                        for w in s.words or []
                    ],
                }
                for s in segs
            ],
        }
    (out / f"{name}.baseline.json").write_text(
        json.dumps(baseline, ensure_ascii=False, indent=2)
    )
    result = review(
        model, baseline, {"audio_file": str(path)}, lambda m, p: None, lambda: False
    )
    (out / f"{name}.review.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2)
    )
    old = normalize("".join(s["text"] for s in baseline["segments"]))
    new = normalize("".join(s["text"] for s in result["segments"]))
    report = {
        "case": name,
        "seconds": round(time.monotonic() - start, 1),
        "baseline_chars": len(old),
        "review_chars": len(new),
        "unchanged": old == new,
        "review": {
            k: v
            for k, v in result.get("speechReview", {}).items()
            if k not in ["changes", "unresolved", "checks"]
        },
        "changes": [
            {k: v for k, v in c.items() if k != "words"}
            for c in result.get("speechReview", {}).get("changes", [])
        ],
    }
    if name in ["silence", "noise", "tones"]:
        assert len(new) == 0, (name, "non-speech generated text")
    summaries.append(report)
    (out / "summary.json").write_text(
        json.dumps(summaries, ensure_ascii=False, indent=2)
    )
    print(json.dumps(report, ensure_ascii=False), flush=True)
