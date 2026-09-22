"""Budget regression: new short-cue confirmations must not displace primary work."""

import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "extraResources/python-review"))
import speech_review
from test_review_core import words, segment
from test_short_retime import fixture


class ReviewBudgetTests(unittest.TestCase):
    def test_short_confirmation_preserves_later_text_and_timing_checks(self):
        original, short_decode, short_candidate, speech = fixture()
        left, right = words("we checked the first section", 30), words("now continue with another section", 34)
        original += [segment(left), segment(right)]
        content_decode = [segment(left + words("and recovered this sentence", 32) + right)]
        content_candidate = {"start": 32, "end": 32.1, "kind": "speech"}
        correct = words("now return to the drawing", 45)
        early = copy.deepcopy(correct)
        early[0]["start"], early[0]["end"] = 42, 42.3
        original.append(segment(early))
        timing_candidate = {"start": 42, "end": 45.7, "kind": "timing"}
        calls = []

        def window(candidate, duration, extra=0, segments=None):
            if candidate["start"] == short_candidate["start"]:
                return (0, 16) if extra else (0, 20)
            if candidate["start"] == 32:
                return (26, 40) if extra else (28, 38)
            return (38, 54)

        def decode(model, path, a, b, *args):
            calls.append((a, b))
            return short_decode if a == 0 else content_decode if a < 30 else [segment(correct)]

        with patch.object(speech_review, "scan_speech", return_value=(speech + [(32, 33.4), (45, 47)], 60, [(8.8, 9)])), \
             patch.object(speech_review, "find_candidates", return_value=[content_candidate, timing_candidate]), \
             patch.object(speech_review, "window_for", side_effect=window), \
             patch.object(speech_review, "decode_window", side_effect=decode):
            result = speech_review.review(None, {"segments": original}, {"audio_file": "fixture"}, lambda *a: None, lambda: False)
        summary = result["speechReview"]
        # Primary decodes and content confirmation use their complete 60 seconds
        # before the new timing confirmation spends its separate allowance.
        self.assertEqual(calls, [(0, 20), (28, 38), (26, 40), (38, 54), (0, 16)])
        self.assertEqual(summary["recovered"], 1)
        self.assertEqual(summary["retimed"], 2)
        self.assertEqual(summary["skippedChecks"], [])
        self.assertEqual(summary["budget"]["primaryUsedSeconds"], 60)
        self.assertEqual(summary["budget"]["shortTimingUsedSeconds"], 16)
        self.assertEqual(next(s for s in result["segments"] if s["text"].strip() == "Great.")["start"], 8.4)
        self.assertEqual(result["segments"][-1]["start"], 45)

    def test_deferred_timing_reanchors_after_primary_text_insertion(self):
        original, short_decode, _, speech = fixture()
        for segments in (original, short_decode):
            for s in segments:
                s["start"] += 20
                s["end"] += 20
                for w in s["words"]:
                    w["start"] += 20
                    w["end"] += 20
        left, right = words("we checked the first section", 0), words("now continue with another section", 4)
        original = [segment(left), segment(right)] + original
        content_decode = [segment(left + words("and recovered this sentence", 2) + right)]
        candidate = {"start": 2, "end": 2.1, "kind": "speech"}

        def decode(model, path, a, b, *args):
            return content_decode if a < 10 else short_decode

        with patch.object(speech_review, "scan_speech", return_value=([(a + 20, b + 20) for a, b in speech] + [(2, 3.4)], 60, [(28.8, 29)])), \
             patch.object(speech_review, "find_candidates", return_value=[candidate]), \
             patch.object(speech_review, "decode_window", side_effect=decode):
            result = speech_review.review(None, {"segments": original}, {"audio_file": "fixture"}, lambda *a: None, lambda: False)
        summary = result["speechReview"]
        self.assertEqual(summary["recovered"], 1)
        self.assertEqual(summary["retimed"], 1)
        change = summary["timingChanges"][0]
        self.assertEqual(change["segment_index"], 4)  # Was 3 before text insertion.
        self.assertEqual(result["segments"][4]["text"].strip(), "Great.")
        self.assertAlmostEqual(result["segments"][4]["start"], 28.4)
        self.assertEqual(result["segments"][3]["text"], original[2]["text"])

    def test_extra_budget_exhaustion_retains_hint_and_primary_check(self):
        original, decoded, candidate, speech = fixture()
        primary = {"start": 12, "end": 14, "kind": "timing"}

        def window(c, duration, extra=0, segments=None):
            return (0, 21) if extra else (0, 10)

        with patch.object(speech_review, "scan_speech", return_value=(speech, 30, [(8.8, 9)])), \
             patch.object(speech_review, "find_candidates", return_value=[primary]), \
             patch.object(speech_review, "window_for", side_effect=window), \
             patch.object(speech_review, "decode_window", return_value=decoded) as decode:
            result = speech_review.review(None, {"segments": original}, {"audio_file": "fixture"}, lambda *a: None, lambda: False)
        self.assertEqual(decode.call_count, 2)
        self.assertEqual(result["segments"], original)
        summary = result["speechReview"]
        self.assertEqual(summary["checked"], 2)
        self.assertEqual(summary["budget"]["shortTimingConfirmations"], 0)
        self.assertEqual(summary["unresolved"][0]["issue"], "timing")
        self.assertEqual(summary["unresolved"][0]["reason"], "budget")

    def test_extra_confirmation_count_is_bounded_and_cancellable(self):
        original, decoded, candidate, speech = fixture()
        pulses = [(8.5 + i * .12, 8.55 + i * .12) for i in range(5)]
        # Keep every candidate unresolved, so all five reach confirmation.
        with patch.object(speech_review, "scan_speech", return_value=(speech, 3000, pulses)), \
             patch.object(speech_review, "find_candidates", return_value=[]), \
             patch.object(speech_review, "window_for", side_effect=lambda c, d, extra=0, segments=None: (0, 2 if extra else 1)), \
             patch.object(speech_review, "decode_window", return_value=decoded) as decode, \
             patch.object(speech_review, "agree_short_retimes", return_value=False):
            result = speech_review.review(None, {"segments": original}, {"audio_file": "fixture"}, lambda *a: None, lambda: False)
        summary = result["speechReview"]
        self.assertEqual(decode.call_count, 9)
        self.assertEqual(summary["budget"]["shortTimingConfirmations"], 4)
        self.assertEqual(summary["unresolved"][-1]["reason"], "budget")
        with patch.object(speech_review, "scan_speech", return_value=(speech, 30, [(8.8, 9)])), \
             patch.object(speech_review, "find_candidates", return_value=[]), \
             patch.object(speech_review, "decode_window", return_value=decoded) as decode:
            with self.assertRaises(speech_review.ReviewCancelled):
                speech_review.review(None, {"segments": original}, {"audio_file": "fixture"}, lambda *a: None, lambda: decode.call_count >= 1)
        self.assertEqual(decode.call_count, 1)

    def test_extra_audio_allowance_is_cumulative(self):
        original, decoded, _, speech = fixture()
        pulses = [(8.5 + i * .12, 8.55 + i * .12) for i in range(3)]
        with patch.object(speech_review, "scan_speech", return_value=(speech, 30, pulses)), \
             patch.object(speech_review, "find_candidates", return_value=[]), \
             patch.object(speech_review, "window_for", side_effect=lambda c, d, extra=0, segments=None: (0, 12 if extra else 1)), \
             patch.object(speech_review, "decode_window", return_value=decoded) as decode, \
             patch.object(speech_review, "agree_short_retimes", return_value=False):
            result = speech_review.review(None, {"segments": original}, {"audio_file": "fixture"}, lambda *a: None, lambda: False)
        summary = result["speechReview"]
        self.assertEqual(decode.call_count, 4)
        self.assertEqual(summary["budget"]["primaryUsedSeconds"], 3)
        self.assertEqual(summary["budget"]["shortTimingUsedSeconds"], 12)
        self.assertEqual([p["reason"] for p in summary["unresolved"]], ["disagreement", "budget", "budget"])


if __name__ == "__main__":
    unittest.main()
