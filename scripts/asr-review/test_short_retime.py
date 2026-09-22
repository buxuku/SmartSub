import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "extraResources/python-review"))
from review_core import propose_short_retime, agree_short_retimes, apply_short_retime
import speech_review
from test_review_core import words, segment


def fixture(token="Great."):
    left, right = words("as much as I can", 1), words("everything else is fine with me", 9)
    original = [segment(left), segment(words(token, 3, .4)), segment(right)]
    decoded = [segment(copy.deepcopy(left) + words(token.lower().replace(".", ","), 8.4, .4) + copy.deepcopy(right))]
    candidate = {"start": 8.8, "end": 9.0, "kind": "speech", "brief": True}
    speech = [(1, 2.8), (8.8, 11.5)]
    return original, decoded, candidate, speech


class ShortRetimeTests(unittest.TestCase):
    def test_move_only_time_preserve_every_character_and_neighbour(self):
        for token in ["Great.", "Oh!", "谢谢！"]:
            original, decoded, candidate, speech = fixture(token)
            snapshot = copy.deepcopy(original)
            proposal = propose_short_retime(original, decoded, candidate, speech, 20)
            self.assertIsNotNone(proposal)
            output = apply_short_retime(original, proposal)
            self.assertEqual(original, snapshot)
            self.assertEqual([s["text"] for s in output], [s["text"] for s in original])
            self.assertEqual(output[0], original[0])
            self.assertEqual(output[2], original[2])
            self.assertEqual(output[1]["words"][0]["word"], original[1]["words"][0]["word"])
            self.assertEqual(output[1]["start"], 8.4)

    def test_supported_old_utterance_is_not_moved_or_duplicated(self):
        original, decoded, candidate, speech = fixture()
        self.assertIsNone(propose_short_retime(original, decoded, candidate, speech + [(3, 3.4)], 20))
        hint = propose_short_retime(original, decoded, candidate, speech + [(3, 3.4)], 20, suggestion_only=True)
        self.assertEqual(hint["text"].strip(), "Great.")
        duplicate = copy.deepcopy(decoded[0]["words"])
        for w in duplicate:
            w["start"] += .01
            w["end"] += .01
        self.assertIsNone(propose_short_retime(original, decoded + [segment(duplicate)], candidate, speech, 20))

    def test_crossing_neighbour_or_changed_anchor_is_rejected(self):
        original, decoded, candidate, speech = fixture()
        decoded[0]["words"][5]["end"] = 9.1
        self.assertIsNone(propose_short_retime(original, decoded, candidate, speech, 20))
        original, decoded, candidate, speech = fixture()
        decoded[0]["words"][4]["word"] = " cannot"
        self.assertIsNone(propose_short_retime(original, decoded, candidate, speech, 20))

    def test_small_alignment_jitter_is_clamped_before_confirmation(self):
        original, decoded, candidate, speech = fixture()
        primary = propose_short_retime(original, decoded, candidate, speech, 20)
        decoded[0]["words"][5]["start"] = 8.62
        decoded[0]["words"][5]["end"] = 9.07
        confirmation = propose_short_retime(original, decoded, candidate, speech, 20)
        self.assertIsNotNone(confirmation)
        self.assertEqual(confirmation["end"], original[2]["start"])
        self.assertTrue(agree_short_retimes(primary, confirmation))
        output = apply_short_retime(original, confirmation)
        self.assertEqual(output[1]["words"][-1]["end"], output[2]["start"])
        self.assertEqual(output[2], original[2])

    def test_weak_or_unsupported_new_location_is_rejected(self):
        original, decoded, candidate, speech = fixture()
        self.assertIsNone(propose_short_retime(original, decoded, candidate, [], 20))
        decoded[0]["words"][5]["probability"] = .01
        self.assertIsNone(propose_short_retime(original, decoded, candidate, speech, 20))

    def run_review(self, second=None, duration=20, cancel=None):
        original, decoded, candidate, speech = fixture()
        with patch.object(speech_review, "scan_speech", return_value=(speech, duration, [(8.8, 9.0)])), \
             patch.object(speech_review, "find_candidates", return_value=[]), \
             patch.object(speech_review, "decode_window", side_effect=[decoded, second or decoded]) as decode:
            result = speech_review.review(None, {"segments": original}, {"audio_file": "fixture"}, lambda *a: None, cancel or (lambda: False))
        return result, decode.call_count, original

    def test_flow_confirms_then_retimes_without_inserting(self):
        result, calls, original = self.run_review()
        self.assertEqual(calls, 2)
        self.assertEqual(result["speechReview"]["recovered"], 0)
        self.assertEqual(result["speechReview"]["retimed"], 1)
        self.assertEqual(result["speechReview"]["pending"], 0)
        self.assertEqual(len(result["segments"]), len(original))
        self.assertEqual(result["speechReview"]["timingChanges"][0]["originalStart"], 3)

    def test_disagreement_keeps_timing_warning_and_original(self):
        _, second, _, _ = fixture()
        second[0]["words"][5]["start"] = 7.9
        second[0]["words"][5]["end"] = 8.3
        result, calls, original = self.run_review(second)
        self.assertEqual(result["segments"], original)
        warning = result["speechReview"]["unresolved"][0]
        self.assertEqual(warning["issue"], "timing")
        self.assertEqual(warning["suggestedText"].strip(), "Great.")
        self.assertEqual(result["speechReview"]["retimed"], 0)

    def test_confirmation_budget_and_identical_context_do_not_move_text(self):
        for windows, reason in [([(0, 40), (0, 50)], "budget"), ([(0, 20), (0, 20)], "context")]:
            with patch.object(speech_review, "window_for", side_effect=windows):
                result, calls, original = self.run_review()
            self.assertEqual(calls, 1)
            self.assertEqual(result["segments"], original)
            self.assertEqual(result["speechReview"]["unresolved"][0]["reason"], reason)

    def test_ambiguous_old_speech_keeps_a_timing_hint_without_second_decode(self):
        original, decoded, _, speech = fixture()
        with patch.object(speech_review, "scan_speech", return_value=(speech + [(3, 3.4)], 20, [(8.8, 9.0)])), \
             patch.object(speech_review, "find_candidates", return_value=[]), \
             patch.object(speech_review, "decode_window", return_value=decoded) as decode:
            result = speech_review.review(None, {"segments": original}, {"audio_file": "fixture"}, lambda *a: None, lambda: False)
        self.assertEqual(decode.call_count, 1)
        self.assertEqual(result["segments"], original)
        self.assertEqual(result["speechReview"]["unresolved"][0]["issue"], "timing")

    def test_clear_brief_text_difference_survives_without_automatic_change(self):
        left, right = words("we checked the first section", 0), words("now continue with another section", 4)
        original = [segment(left + words("around", 2) + right)]
        decoded = [segment(left + words("near", 2) + right)]
        candidate = {"start": 2, "end": 2.35, "kind": "speech", "brief": True}
        with patch.object(speech_review, "scan_speech", return_value=([(0, 6)], 20, [(2, 2.35)])), \
             patch.object(speech_review, "find_candidates", return_value=[]), \
             patch.object(speech_review, "decode_window", return_value=decoded) as decode:
            result = speech_review.review(None, {"segments": original}, {"audio_file": "fixture"}, lambda *a: None, lambda: False)
        self.assertEqual(decode.call_count, 1)
        self.assertEqual(result["segments"], original)
        pending = result["speechReview"]["unresolved"][0]
        self.assertEqual(pending["issue"], "text")
        self.assertEqual(pending["originalText"].strip(), "around")
        self.assertEqual(pending["suggestedText"].strip(), "near")


if __name__ == "__main__":
    unittest.main()
