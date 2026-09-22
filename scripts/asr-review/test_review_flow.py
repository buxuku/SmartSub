import copy
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(
    0, str(Path(__file__).resolve().parents[2] / "extraResources/python-review")
)
import speech_review
from test_review_core import words, segment


class ReviewFlowTests(unittest.TestCase):
    def baseline(self):
        return {
            "language": "en",
            "segments": [
                segment(words("we checked the first section", 0)),
                segment(words("now continue with another section", 4)),
            ],
        }

    def decoded(self):
        b = self.baseline()["segments"]
        return [
            segment(
                b[0]["words"] + words("and recovered this sentence", 2) + b[1]["words"]
            )
        ]

    def test_two_confirmations_preserve_baseline(self):
        baseline = self.baseline()
        snapshot = copy.deepcopy(baseline)
        with patch.object(
            speech_review, "scan_speech", return_value=([(2, 3.4)], 20, [])
        ), patch.object(
            speech_review, "decode_window", return_value=self.decoded()
        ) as decode:
            result = speech_review.review(
                None,
                baseline,
                {"audio_file": "fixture"},
                lambda *x: None,
                lambda: False,
            )
        self.assertEqual(decode.call_count, 2)
        self.assertEqual(result["speechReview"]["recovered"], 1)
        self.assertEqual(baseline, snapshot)
        self.assertEqual(result["beforeReviewSegments"], baseline["segments"])

    def test_disagreement_keeps_candidate_and_original(self):
        baseline = self.baseline()
        second = self.decoded()
        second[0]["words"][6]["word"] = " removed"
        second[0]["text"] = "".join(w["word"] for w in second[0]["words"])
        with patch.object(
            speech_review, "scan_speech", return_value=([(2, 3.4)], 20, [])
        ), patch.object(
            speech_review, "decode_window", side_effect=[self.decoded(), second]
        ):
            result = speech_review.review(
                None,
                baseline,
                {"audio_file": "fixture"},
                lambda *x: None,
                lambda: False,
            )
        self.assertEqual(result["segments"], baseline["segments"])
        self.assertEqual(result["speechReview"]["recovered"], 0)
        self.assertTrue(result["speechReview"]["unresolved"][0]["suggestedText"])

    def test_identical_context_on_short_clip_is_not_independent_confirmation(self):
        with patch.object(
            speech_review, "scan_speech", return_value=([(2, 3.4)], 7, [])
        ), patch.object(
            speech_review, "decode_window", return_value=self.decoded()
        ) as decode:
            result = speech_review.review(
                None,
                self.baseline(),
                {"audio_file": "fixture"},
                lambda *x: None,
                lambda: False,
            )
        self.assertEqual(decode.call_count, 1)
        self.assertEqual(result["speechReview"]["recovered"], 0)
        self.assertEqual(result["speechReview"]["unresolved"][0]["reason"], "context")

    def test_cancel_after_scan(self):
        with patch.object(
            speech_review, "scan_speech", return_value=([(2, 3.4)], 20, [])
        ):
            with self.assertRaises(speech_review.ReviewCancelled):
                speech_review.review(
                    None,
                    self.baseline(),
                    {"audio_file": "fixture"},
                    lambda *x: None,
                    lambda: True,
                )

    def test_partial_metadata_fails_open(self):
        b = self.baseline()
        b["segments"][0]["words"] = []
        result = speech_review.review(None, b, {}, lambda *x: None, lambda: False)
        self.assertEqual(result["segments"], b["segments"])
        self.assertEqual(result["speechReview"]["status"], "unavailable")

    def test_empty_result_with_speech_remains_visible(self):
        with patch.object(
            speech_review, "scan_speech", return_value=([(2, 3.4)], 20, [])
        ), patch.object(speech_review, "decode_window", return_value=self.decoded()):
            result = speech_review.review(
                None,
                {"segments": []},
                {"audio_file": "fixture"},
                lambda *x: None,
                lambda: False,
            )
        self.assertEqual(result["segments"], [])
        self.assertEqual(result["speechReview"]["pending"], 1)

    def test_silence_does_not_decode_or_invent_text(self):
        with patch.object(
            speech_review, "scan_speech", return_value=([], 12, [])
        ), patch.object(speech_review, "decode_window") as decode:
            result = speech_review.review(
                None,
                {"segments": []},
                {"audio_file": "fixture"},
                lambda *x: None,
                lambda: False,
            )
        decode.assert_not_called()
        self.assertEqual(result["speechReview"]["status"], "complete")
        self.assertEqual(result["speechReview"]["pending"], 0)

    def test_brief_pulse_under_wrong_word_time_still_reviewed(self):
        with patch.object(
            speech_review, "scan_speech", return_value=([(0, 6)], 7, [(0.5, 0.65)])
        ), patch.object(
            speech_review, "find_candidates", return_value=[]
        ), patch.object(
            speech_review, "decode_window", return_value=self.baseline()["segments"]
        ) as decode:
            result = speech_review.review(
                None,
                self.baseline(),
                {"audio_file": "fixture"},
                lambda *x: None,
                lambda: False,
            )
        self.assertEqual(decode.call_count, 1)
        self.assertEqual(result["speechReview"]["recovered"], 0)

    def test_preserves_custom_vocabulary_and_filters_in_review(self):
        from unittest.mock import Mock

        model = Mock()
        model.transcribe.return_value = (iter([]), None)
        with patch.object(speech_review, "read_audio", return_value=([], 10)):
            speech_review.decode_window(
                model,
                "fixture",
                0,
                10,
                "zh",
                lambda: False,
                {
                    "initial_prompt": "专有名词",
                    "no_repeat_ngram_size": 3,
                    "no_speech_threshold": 0.4,
                },
            )
        options = model.transcribe.call_args.kwargs
        self.assertEqual(options["initial_prompt"], "专有名词")
        self.assertEqual(options["no_repeat_ngram_size"], 3)
        self.assertEqual(options["no_speech_threshold"], 0.4)
        self.assertFalse(options["condition_on_previous_text"])

    def test_retime_only_exact_text(self):
        ws = words("now return to the drawing", 10)
        old = copy.deepcopy(ws)
        old[0]["start"] = 2
        old[0]["end"] = 2.3
        baseline = [segment(old)]
        candidate = {"start": 2, "end": 10.7, "kind": "timing"}
        result = speech_review.retime_segment(baseline, [segment(ws)], candidate)
        self.assertEqual(result[0]["start"], 10)
        self.assertEqual(result[0]["text"], baseline[0]["text"])
        ws[2]["word"] = " different"
        self.assertIsNone(
            speech_review.retime_segment(baseline, [segment(ws)], candidate)
        )

    def test_retime_does_not_create_zero_duration_words(self):
        ws = words("now return to the drawing", 10)
        old = copy.deepcopy(ws)
        old[0]["start"] = 2
        old[0]["end"] = 2.3
        ws[1]["end"] = ws[1]["start"]
        self.assertIsNone(
            speech_review.retime_segment(
                [segment(old)],
                [segment(ws)],
                {"start": 2, "end": 10.7, "kind": "timing"},
            )
        )

    def test_retime_preserves_original_punctuation_and_case(self):
        ws = words("now return to the drawing", 10)
        old = copy.deepcopy(ws)
        old[0]["start"] = 2
        old[0]["end"] = 2.3
        old[0]["word"] = " Now"
        old[-1]["word"] = " drawing..."
        output = speech_review.retime_segment(
            [segment(old)], [segment(ws)], {"start": 2, "end": 10.7, "kind": "timing"}
        )
        self.assertEqual(
            [w["word"] for w in output[0]["words"]], [w["word"] for w in old]
        )


if __name__ == "__main__":
    unittest.main()
