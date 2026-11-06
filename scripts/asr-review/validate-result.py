"""Validate review output against its saved first pass and accepted edit audit."""

import argparse, json, sys
from pathlib import Path

sys.path.insert(
    0, str(Path(__file__).resolve().parents[2] / "extraResources/python-review")
)
from review_core import apply_edit, flatten_words, normalize

p = argparse.ArgumentParser()
p.add_argument("--result", required=True)
p.add_argument("--output", required=True)
a = p.parse_args()
r = json.loads(Path(a.result).read_text())
original = r["beforeReviewSegments"]
reviewed = r["segments"]
summary = r["speechReview"]
if "budget" in summary:
    budget = summary["budget"]
    primary = sum(c["window"][1] - c["window"][0] for c in summary["checks"])
    extra, confirmations = 0.0, 0
    for check in summary["checks"]:
        if "confirmation" not in check:
            continue
        window_start, window_end = check["confirmationWindow"]
        if check.get("confirmationPurpose") == "shortTiming":
            extra += window_end - window_start
            confirmations += 1
        else:
            primary += window_end - window_start
    assert abs(primary - budget["primaryUsedSeconds"]) <= .001, "Primary budget audit mismatch"
    assert abs(extra - budget["shortTimingUsedSeconds"]) <= .001, "Short timing budget audit mismatch"
    assert primary <= budget["primaryLimitSeconds"] + .001, "Primary audio budget exceeded"
    assert extra <= budget["shortTimingLimitSeconds"] + .001, "Short timing audio budget exceeded"
    assert len(summary["checks"]) <= budget["primaryCandidateLimit"], "Primary candidate limit exceeded"
    assert confirmations == budget["shortTimingConfirmations"], "Confirmation count audit mismatch"
    assert confirmations <= budget["shortTimingConfirmationLimit"], "Extra confirmation limit exceeded"
# Replaying accepted text edits must account for every changed character.
replayed = original
for change in summary["changes"]:
    replayed = apply_edit(replayed, change)
expected = normalize("".join(s["text"] for s in replayed))
actual = normalize("".join(s["text"] for s in reviewed))
assert expected == actual, "Unaudited text change"
assert "".join(s["text"] for s in replayed) == "".join(
    s["text"] for s in reviewed
), "Unaudited punctuation or casing change"
for s in reviewed:
    assert normalize(s["text"]) == normalize(
        "".join(w["word"] for w in s.get("words", []))
    ), "Segment/word text mismatch"
    assert s["end"] >= s["start"] >= 0, "Invalid segment time"


def stats(segs):
    ws = flatten_words(segs)
    return {
        "cues": len(segs),
        "words": len(ws),
        "characters": len(normalize("".join(s["text"] for s in segs))),
        "zero_duration_words": sum(w["end"] == w["start"] for w in ws),
        "overlapping_words": sum(
            b["start"] < a["end"] - 0.001 for a, b in zip(ws, ws[1:])
        ),
        "nonpositive_cues": sum(s["end"] <= s["start"] for s in segs),
    }


# A short timing repair must preserve tokens and use an independently decoded
# location; audited timing changes do not add to the recovered-text count.
for change in summary.get("timingChanges", []):
    matching = [s for s in reviewed if s["text"] == change["text"]
                and abs(s["start"] - change["start"]) < .001
                and abs(s["end"] - change["end"]) < .001]
    assert len(matching) == 1, "Timing repair missing or duplicated"
    before = [s for s in original if s["text"] == change["text"]
              and s["start"] == change["originalStart"]
              and s["end"] == change["originalEnd"]]
    assert len(before) == 1, "Timing repair lacks original cue"
    assert [w["word"] for w in matching[0]["words"]] == [w["word"] for w in before[0]["words"]]
    assert any(c.get("confirmation") and c.get("confirmationWindow")
               and c["window"] != c["confirmationWindow"]
               and abs(c["start"] - change["start"]) < 1
               for c in summary["checks"]), "Timing repair lacks independent confirmation"


old, new = stats(original), stats(reviewed)
assert (
    new["overlapping_words"] <= old["overlapping_words"]
), "New overlapping word timestamps"
assert (
    new["zero_duration_words"] <= old["zero_duration_words"]
), "New zero-duration words"
assert new["nonpositive_cues"] <= old["nonpositive_cues"], "New invalid cues"
result = {
    "before": old,
    "after": new,
    "audited_text_only": True,
    "review": {
        k: v for k, v in summary.items() if k not in ["changes", "checks", "unresolved"]
    },
    "changes": [
        {k: v for k, v in c.items() if k != "words"} for c in summary["changes"]
    ],
    "unresolved": summary["unresolved"],
}
Path(a.output).write_text(json.dumps(result, ensure_ascii=False, indent=2))
print(
    json.dumps(
        {k: v for k, v in result.items() if k not in ["changes", "unresolved"]},
        ensure_ascii=False,
    )
)
