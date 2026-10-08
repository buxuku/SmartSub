"""Long-audio guards for the speech review.

A ten hour video has ~10^5 words and thousands of VAD spans. Work that is
quadratic in either made the review run for many minutes without emitting a
single event (the task looked frozen at ~90 %). These tests pin the optimised
helpers to the straightforward implementations they replaced, and fail if the
cost starts to grow with the length of the transcript again.
"""

import random
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(
    0, str(Path(__file__).resolve().parents[2] / "extraResources/python-review")
)
import review_core
import speech_review
from review_core import (
    find_candidates,
    flatten_words,
    merge_ranges,
    overlap,
    subtract_ranges,
    window_for,
)
from test_review_core import segment, words


def naive_find_candidates(segments, speech, duration):
    """The original find_candidates: re-merges and rescans the whole covered
    list for every VAD span. Kept verbatim as the oracle."""
    flat = flatten_words(segments)
    covered = [(s["start"], s["end"]) for s in segments if not s.get("words")]
    covered.extend((w["start"] - 0.2, w["end"] + 0.2) for w in flat)
    covered = merge_ranges(covered)
    gaps = []
    for start, end in speech:
        missing = subtract_ranges([(start, end)], covered)
        for a, b in missing:
            standalone = overlap(start, end, covered) < 0.05
            if b - a >= (0.1 if standalone else 0.7):
                gaps.append([a, b])
    groups = merge_ranges(gaps, 0.65)
    result = []
    for a, b in groups:
        while b - a > 16:
            result.append({"start": a, "end": a + 16, "kind": "speech"})
            a += 16
        result.append({"start": a, "end": min(duration, b), "kind": "speech"})
    for s in segments:
        group = s.get("words", [])
        if len(group) < 3:
            continue
        w, next_word = group[:2]
        if (
            next_word["start"] - w["end"] >= 2
            and any(abs(w["start"] - end) < 0.45 for start, end in speech)
            and overlap(w["end"] + 0.3, next_word["start"] - 0.3, speech) < 0.5
        ):
            result.append(
                {"start": w["start"], "end": next_word["end"], "kind": "timing"}
            )
    return sorted(result, key=lambda r: (r["start"], r["end"]))


def naive_window_for(candidate, duration, extra=0.0, segments=None):
    """The original window_for: flattens and filters the whole transcript."""
    a, b = candidate["start"] - 5, candidate["end"] + 5
    if segments:
        flat = flatten_words(segments)
        left = [w for w in flat if w["end"] <= candidate["start"]]
        right = [w for w in flat if w["start"] >= candidate["end"]]
        if left:
            a = min(
                a,
                max(
                    candidate["start"] - 10, left[max(0, len(left) - 3)]["start"] - 0.4
                ),
            )
        if right:
            b = max(
                b,
                min(candidate["end"] + 10, right[min(2, len(right) - 1)]["end"] + 0.4),
            )
    return max(0, a - extra), min(duration, b + extra)


def random_transcript(rnd, shuffled=False):
    """Segments with and without word timing; `shuffled` breaks time order."""
    segments, t = [], rnd.uniform(0, 5)
    for _ in range(rnd.randint(0, 25)):
        ws, cursor = [], t
        for _ in range(rnd.choice([0, 1, 2, 3, 6, 12])):
            cursor += rnd.choice([0.0, 0.05, 0.3, 0.9, 2.5])
            length = rnd.choice([0.05, 0.2, 0.4, 0.8])
            ws.append(
                {
                    "word": rnd.choice([" a", " the", " word", " 你好"]),
                    "start": cursor,
                    "end": cursor + length,
                    "probability": rnd.random(),
                }
            )
            cursor += length
        seg = {
            "start": t,
            "end": max(cursor, t + 0.5),
            "text": "".join(w["word"] for w in ws),
        }
        if ws or rnd.random() < 0.5:
            seg["words"] = ws
        segments.append(seg)
        t = seg["end"] + rnd.choice([0.0, 0.5, 4.0, 30.0])
    if shuffled:
        rnd.shuffle(segments)
    return segments, t + rnd.uniform(0, 20)


def random_speech(rnd, duration):
    spans = []
    for _ in range(rnd.randint(0, 60)):
        start = rnd.uniform(-1, duration + 1)
        spans.append([start, start + rnd.choice([-1, 0, 0.05, 0.2, 1, 5, 30, 200])])
    if rnd.random() < 0.3:
        spans.sort()
    return spans


class OptimisedHelpersMatchTheirReferences(unittest.TestCase):
    def test_find_candidates_matches_reference(self):
        rnd = random.Random(20261008)
        for case in range(400):
            segments, duration = random_transcript(rnd, shuffled=case % 5 == 4)
            speech = random_speech(rnd, duration)
            self.assertEqual(
                find_candidates(segments, speech, duration),
                naive_find_candidates(segments, speech, duration),
                f"case {case}",
            )

    def test_window_for_matches_reference(self):
        rnd = random.Random(7)
        for case in range(300):
            segments, duration = random_transcript(rnd, shuffled=case % 4 == 3)
            for _ in range(10):
                start = rnd.uniform(-2, duration)
                candidate = {"start": start, "end": start + rnd.choice([0, 0.1, 2, 16])}
                for extra in (0.0, 2):
                    self.assertEqual(
                        window_for(candidate, duration, extra, segments),
                        naive_window_for(candidate, duration, extra, segments),
                        f"case {case} {candidate} extra={extra}",
                    )

    def test_flatten_words_returns_independent_copies(self):
        source = [segment(words("alpha beta gamma", 1))]
        # Words are flat today; a newer engine could add nested fields.
        source[0]["words"][1]["tokens"] = [1, 2]
        flat = flatten_words(source)
        flat[0]["word"] = " changed"
        flat[0]["start"] = 99
        flat[1]["tokens"].append(3)
        self.assertEqual(source[0]["words"][0]["word"], " alpha")
        self.assertEqual(source[0]["words"][0]["start"], 1)
        self.assertEqual(source[0]["words"][1]["tokens"], [1, 2])


def ten_hours_of_speech():
    """~10^5 words in 6000 bursts of speech (one VAD span each) plus 1000 short
    utterances in the pauses that the first pass missed."""
    segments, speech = [], []
    for burst in range(6000):
        t = burst * 6.0
        segments.append(segment(words(" ".join(["word"] * 17), t, 0.3)))
        speech.append((t - 0.1, t + 5.2))
        if burst % 6 == 0:
            # Inside the pause, clear of the 0.2 s padding of both neighbours.
            speech.append((t + 5.4, t + 5.7))
    return segments, speech, 36000.0


class LongAudioCost(unittest.TestCase):
    def test_find_candidates_on_ten_hours_of_speech(self):
        segments, speech, duration = ten_hours_of_speech()
        started = time.perf_counter()
        candidates = find_candidates(segments, speech, duration)
        elapsed = time.perf_counter() - started
        self.assertEqual(len(candidates), 1000)
        # ~0.2 s expected; the quadratic version needs ~20 s on the same input.
        self.assertLess(elapsed, 3.0, f"find_candidates took {elapsed:.1f}s")

    def test_review_does_not_rescan_the_transcript_for_skipped_candidates(self):
        """Candidates beyond the check limit are only recorded. Looking at them
        must not cost a pass over the whole transcript each."""

        def flatten_calls(candidate_count):
            calls = []

            def counting(segments):
                calls.append(1)
                return flatten_words(segments)

            spans = [(100 + 30 * i, 101 + 30 * i) for i in range(candidate_count)]
            # A long recording, so the 24 check limit (not the audio budget) is
            # what stops the review.
            with patch.object(review_core, "flatten_words", counting), patch.object(
                speech_review, "flatten_words", counting
            ), patch.object(
                speech_review, "scan_speech", return_value=(spans, 36000, [])
            ), patch.object(speech_review, "decode_window", return_value=[]):
                result = speech_review.review(
                    None,
                    {"segments": [segment(words("we checked the first section", 0))]},
                    {"audio_file": "fixture"},
                    lambda *a: None,
                    lambda: False,
                )
            summary = result["speechReview"]
            self.assertEqual(summary["checked"], 24)
            self.assertEqual(len(summary["skippedChecks"]), candidate_count - 24)
            return len(calls)

        self.assertEqual(flatten_calls(90), flatten_calls(30))

    def test_later_windows_are_computed_from_the_repaired_transcript(self):
        """After one candidate is repaired the next candidate's anchors must come
        from the repaired text, not from a transcript cached before the repair."""
        first = words("we checked the first section", 0)
        last = words("now continue with another section", 11)
        recovered = [segment(first + words("and recovered this sentence", 2) + last)]
        decodes = []

        def decode(model, path, start, end, *args):
            decodes.append((start, end))
            return recovered if len(decodes) <= 2 else []

        with patch.object(
            speech_review, "scan_speech", return_value=([(2, 3.4), (9, 10.2)], 40, [])
        ), patch.object(speech_review, "decode_window", side_effect=decode):
            result = speech_review.review(
                None,
                {"segments": [segment(first), segment(last)]},
                {"audio_file": "fixture"},
                lambda *a: None,
                lambda: False,
            )
        self.assertEqual(result["speechReview"]["recovered"], 1)
        self.assertEqual(len(decodes), 3)
        later = {"start": 9, "end": 10.2, "kind": "speech"}
        # The repair inserted words just before the later candidate, which moves
        # its left anchor; a stale cache would give the pre-repair window.
        self.assertEqual(
            decodes[2], window_for(later, 40, segments=result["segments"])
        )
        self.assertNotEqual(
            decodes[2], window_for(later, 40, segments=[segment(first), segment(last)])
        )


if __name__ == "__main__":
    unittest.main()
