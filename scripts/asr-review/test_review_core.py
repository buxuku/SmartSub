import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(
    0, str(Path(__file__).resolve().parents[2] / "extraResources/python-review")
)
from review_core import (
    agree_edits,
    apply_edit,
    confidence,
    find_candidates,
    flatten_words,
    merge_ranges,
    normalize,
    propose_edit,
    subtract_ranges,
    window_for,
)


def words(texts, start=0, step=0.35):
    return [
        {
            "word": " " + t,
            "start": start + i * step,
            "end": start + (i + 1) * step,
            "probability": 0.98,
        }
        for i, t in enumerate(texts.split())
    ]


def segment(ws):
    return {
        "start": ws[0]["start"],
        "end": ws[-1]["end"],
        "text": "".join(w["word"] for w in ws),
        "words": ws,
    }


class ReviewTests(unittest.TestCase):
    def test_interval_math(self):
        self.assertEqual(
            subtract_ranges([(0, 10)], [(1, 2), (1.5, 4), (8, 12)]), [[0, 1], [4, 8]]
        )
        self.assertEqual(merge_ranges([(3, 4), (0, 1), (0.5, 2)]), [[0, 2], [3, 4]])

    def test_standalone_short_speech_but_not_edge_padding(self):
        original = [segment(words("hello world", 1))]
        candidates = find_candidates(original, [(1, 1.95), (3, 3.16)], 5)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["start"], 3)

    def test_no_voice_no_candidates(self):
        self.assertEqual(
            find_candidates([segment(words("hello world", 1))], [], 20), []
        )

    def test_timing_gap_tolerates_one_brief_sound_but_not_continuous_speech(self):
        ws = words("now return to the next chapter", 10)
        ws[0]["start"], ws[0]["end"] = 2, 2.3
        original = [segment(ws)]
        speech = [(1, 2.1), (6, 6.2), (10, 13)]
        self.assertTrue(
            any(c["kind"] == "timing" for c in find_candidates(original, speech, 14))
        )
        speech[1] = (5, 8)
        self.assertFalse(
            any(c["kind"] == "timing" for c in find_candidates(original, speech, 14))
        )

    def test_missing_word_metadata_not_a_gap(self):
        self.assertEqual(
            find_candidates([{"start": 0, "end": 4, "text": "kept"}], [(1, 2)], 4), []
        )

    def test_recover_bounded_insertion(self):
        left = words("we checked the first section", 0)
        missing = words("and recovered this sentence", 2)
        right = words("now continue with another section", 4)
        original = [segment(left), segment(right)]
        decoded = [segment(left + missing + right)]
        proposal = propose_edit(
            original, decoded, {"start": 2, "end": 3.4}, [(0, 6)], 6
        )
        self.assertIsNotNone(proposal)
        updated = apply_edit(original, proposal)
        self.assertEqual(
            normalize("".join(s["text"] for s in updated)),
            normalize("".join(w["word"] for w in left + missing + right)),
        )
        self.assertEqual(original, [segment(left), segment(right)])
        self.assertEqual(updated[0], original[0])
        self.assertEqual(updated[-1], original[-1])

    def test_same_length_correction_is_not_a_recovered_omission(self):
        left = words("we finished the previous section", 0)
        right = words("the next chapter we continue", 3)
        original = [segment(left + words("In", 2) + right)]
        decoded = [segment(left + words("At", 2) + right)]
        self.assertIsNone(propose_edit(
            original, decoded, {"start": 2, "end": 2.35}, [(0, 6)], 6,
        ))
        suggestion = propose_edit(
            original, decoded, {"start": 2, "end": 2.35}, [(0, 6)], 6,
            suggestion_only=True,
        )
        self.assertEqual(suggestion["text"].strip(), "At")

    def test_vad_boundary_tolerance_allows_a_brief_interjection(self):
        left = words("we finished the previous section", 0)
        missing = words("Great", 2, 0.4)
        right = words("now continue with another section", 3)
        candidate = {"start": 2.45, "end": 2.65}
        proposal = propose_edit(
            [segment(left), segment(right)],
            [segment(left + missing + right)],
            candidate,
            [(2.45, 2.65)],
            6,
        )
        self.assertIsNotNone(proposal)
        self.assertEqual(normalize(proposal["text"]), "great")

    def test_edit_clamps_small_anchor_overlap_without_moving_original(self):
        left = words("we checked the first section", 0)
        right = words("now continue with another section", 4)
        missing = words("recovered words", 2)
        decoded_right = [dict(w) for w in right]
        # The repeated anchor is extended by 50 ms over its next original word.
        missing[-1]["end"] = 4.04
        decoded_right[0]["start"] = 4.04
        decoded_right[0]["end"] = 4.4
        decoded_right[1]["start"] = 4.4
        p = propose_edit(
            [segment(left), segment(right)],
            [segment(left + missing + decoded_right)],
            {"start": 2, "end": 4},
            [(0, 6)],
            7,
        )
        self.assertIsNotNone(p)
        self.assertLessEqual(p["words"][-1]["end"], right[0]["start"])
        output = flatten_words(apply_edit([segment(left), segment(right)], p))
        self.assertTrue(all(b["start"] >= a["end"] for a, b in zip(output, output[1:])))

    def test_bad_word_timing_is_suggestion_only(self):
        left = words("we finished the previous section", 0)
        missing = words("and the head", 2)
        missing[0]["end"] = 4.7
        missing[1]["start"], missing[1]["end"] = 4.7, 5
        missing[2]["start"], missing[2]["end"] = 5, 5.35
        right = words("now continue with another section", 7)
        original, decoded = [segment(left), segment(right)], [
            segment(left + missing + right)
        ]
        candidate, speech = {"start": 5.1, "end": 5.4}, [(5.1, 5.4)]
        self.assertIsNone(propose_edit(original, decoded, candidate, speech, 10))
        self.assertEqual(
            normalize(
                propose_edit(
                    original, decoded, candidate, speech, 10, suggestion_only=True
                )["text"]
            ),
            "andthehead",
        )

    def test_reject_unanchored_hallucination(self):
        original = [
            segment(words("keep this original sentence", 0)),
            segment(words("continue on another day", 5)),
        ]
        decoded = [segment(words("thanks for watching please subscribe", 2))]
        self.assertIsNone(
            propose_edit(original, decoded, {"start": 2, "end": 4}, [(2, 4)], 8)
        )

    def test_disagreement_does_not_apply(self):
        a = {
            "start_index": 1,
            "end_index": 1,
            "text": "three cats",
            "start": 2,
            "end": 3,
        }
        b = {**a, "text": "four cats"}
        self.assertFalse(agree_edits(a, b))
        self.assertFalse(agree_edits(a, {**a, "start": 4}))
        self.assertTrue(agree_edits(a, {**a, "text": " Three cats!"}))

    def test_low_confidence_rejected(self):
        self.assertFalse(
            confidence(words("hello") + [{"word": "noise", "probability": 0.01}])
        )
        self.assertFalse(confidence([{"word": "no metadata"}]))

    def test_cjk_normalization(self):
        self.assertEqual(normalize("你好，世界！"), "你好世界")
        self.assertEqual(normalize("Ａ１２３"), "a123")

    def test_apply_inside_segment_preserves_all_unedited_words(self):
        ws = words("one two three four five six seven eight", 0)
        original = [segment(ws)]
        inserted = words("new words", 0.71, 0.16)
        edit = {"start_index": 2, "end_index": 3, "words": inserted}
        output = apply_edit(original, edit)
        self.assertEqual(flatten_words(output), ws[:2] + inserted + ws[3:])

    def test_repeated_phrase_elsewhere_not_anchor(self):
        original = [
            segment(words("start here and finish there", 0)),
            segment(words("start here and finish there", 50)),
        ]
        decoded = [segment(words("start here and really finish there", 50))]
        proposal = propose_edit(
            original, decoded, {"start": 51, "end": 52}, [(50, 54)], 55
        )
        if proposal:
            self.assertGreaterEqual(proposal["start_index"], 6)

    def test_context_reaches_anchors_across_pause_but_stays_bounded(self):
        original = [
            segment(words("we finished this part", 1)),
            segment(words("continue with the next section", 17)),
        ]
        a, b = window_for({"start": 10, "end": 10.3}, 30, segments=original)
        self.assertLess(a, 2)
        self.assertGreater(b, 18)
        self.assertGreaterEqual(a, 0)
        self.assertLessEqual(b, 20.3)

    def test_cjk_insertion_aligns_with_real_character_anchors(self):
        left = words("今天 我们 学习 中文 课程", 0)
        inserted = words("这是 新的 内容", 2)
        right = words("现在 继续 下一节 课程", 4)
        original = [segment(left), segment(right)]
        proposal = propose_edit(
            original,
            [segment(left + inserted + right)],
            {"start": 2, "end": 3.1},
            [(0, 6)],
            7,
        )
        self.assertIsNotNone(proposal)
        self.assertEqual(normalize(proposal["text"]), "这是新的内容")

    def test_distant_duplicate_does_not_create_an_insertion(self):
        original = [
            segment(words("please check this section", 0)),
            segment(words("please check this section", 30)),
        ]
        decoded = [segment(words("please check this section", 30))]
        self.assertIsNone(
            propose_edit(original, decoded, {"start": 31, "end": 31.4}, [(30, 32)], 35)
        )


if __name__ == "__main__":
    unittest.main()
