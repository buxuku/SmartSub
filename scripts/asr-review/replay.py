"""Review a saved first-pass result against its original WAV (no user files overwritten).
Run with the installed faster-whisper interpreter and site-packages on PYTHONPATH.
"""

import argparse
import json
import sys
import wave
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / "extraResources/python-review"))
from speech_review import review

parser = argparse.ArgumentParser()
parser.add_argument("--baseline", required=True)
parser.add_argument("--audio", required=True)
parser.add_argument("--model", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--threads", type=int, default=2)
parser.add_argument(
    "--decode-cache",
    help="Reuse identical primary and confirmation windows from an earlier review",
)
parser.add_argument(
    "--cache-only", action="store_true",
    help="Revalidate saved decodes without loading a model; fail on any cache miss",
)
args = parser.parse_args()
if args.cache_only and not args.decode_cache:
    parser.error("--cache-only requires --decode-cache")
baseline = json.loads(Path(args.baseline).read_text())
if "beforeReviewSegments" in baseline:
    baseline = {
        **{k: v for k, v in baseline.items() if k not in (
            "speechReview", "reviewSpeechSegments", "beforeReviewSegments"
        )},
        "segments": baseline["beforeReviewSegments"],
    }
if "cues" in baseline:
    words = baseline["words"]["words"]
    baseline = {
        "language": "en",
        "segments": [
            {
                "start": c["start"],
                "end": c["end"],
                "text": c["text"],
                "words": [
                    {
                        "word": w["text"],
                        "start": w["start"] / 1000,
                        "end": w["end"] / 1000,
                    }
                    for w in words
                    if w["start"] / 1000 >= c["start"] and w["start"] / 1000 < c["end"]
                ],
            }
            for c in baseline["cues"]
        ],
    }
    # Zero-duration boundary words must be assigned by text, not only timestamps.
    cursor = 0
    from review_core import normalize

    for c in baseline["segments"]:
        c["words"] = []
        text = ""
        while cursor < len(words) and normalize(text) != normalize(c["text"]):
            w = words[cursor]
            cursor += 1
            text += w["text"]
            c["words"].append(
                {"word": w["text"], "start": w["start"] / 1000, "end": w["end"] / 1000}
            )
        assert normalize(text) == normalize(c["text"])
    assert cursor == len(words)
model = None
if not args.cache_only:
    from faster_whisper import WhisperModel

    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type="auto",
        cpu_threads=args.threads,
        local_files_only=True,
    )
cache_hits = 0
if args.decode_cache:
    import speech_review

    cache_result = json.loads(Path(args.decode_cache).read_text())
    with wave.open(args.audio, "rb") as wav:
        duration = wav.getnframes() / wav.getframerate()
    cache = {}
    for check in cache_result.get("speechReview", {}).get("checks", []):
        a, b = check["window"]
        cache[(round(a, 6), round(b, 6))] = check["decoded"]
        if "confirmation" in check:
            c, d = check.get("confirmationWindow", [max(0, a - 2), min(duration, b + 2)])
            cache[(round(c, 6), round(d, 6))] = check["confirmation"]
    original_decode = speech_review.decode_window

    def cached_decode(model, path, start, end, language, cancelled, params=None):
        global cache_hits
        key = (round(start, 6), round(end, 6))
        if key in cache:
            cache_hits += 1
            return cache[key]
        if args.cache_only:
            raise RuntimeError("Saved decode missing for window %r" % (key,))
        return original_decode(model, path, start, end, language, cancelled, params)

    speech_review.decode_window = cached_decode


def emit(method, data):
    if method == "review":
        print(method, json.dumps(data), flush=True)


result = review(model, baseline, {"audio_file": args.audio}, emit, lambda: False)
if args.decode_cache:
    result["replayValidation"] = {
        "cacheOnly": args.cache_only,
        "cachedDecodes": cache_hits,
        "elapsedSeconds": result["speechReview"]["seconds"],
        "sourceReviewSeconds": cache_result["speechReview"].get("seconds"),
    }
Path(args.output).parent.mkdir(parents=True, exist_ok=True)
Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2))
summary = result.get("speechReview", {})
print(
    json.dumps(
        {
            k: v
            for k, v in summary.items()
            if k not in ["changes", "unresolved", "checks"]
        },
        ensure_ascii=False,
    ),
    flush=True,
)
for change in summary.get("changes", []):
    print(
        "RECOVERED",
        change["start"],
        change["end"],
        repr(change["original"]),
        "=>",
        repr(change["text"]),
        flush=True,
    )
for pending in summary.get("unresolved", []):
    print("PENDING", pending, flush=True)
