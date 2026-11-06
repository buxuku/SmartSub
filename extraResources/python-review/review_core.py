"""Conservative, language-independent speech review. Pure functions, seconds throughout.

The first pass remains authoritative outside a bounded review span. A second,
independent context window must agree before replacing text; alignment anchors
must match the original on both sides. No LLM or remote service is involved.
"""

import bisect
import copy
import difflib
import math
import re
import unicodedata


def merge_ranges(ranges, bridge=0.0):
    result = []
    for start, end in sorted(ranges):
        if not math.isfinite(start + end) or end <= start:
            continue
        if result and start <= result[-1][1] + bridge:
            result[-1][1] = max(result[-1][1], end)
        else:
            result.append([max(0.0, start), end])
    return result


def subtract_ranges(source, covered):
    result = []
    covered = merge_ranges(covered)
    j = 0
    for start, end in merge_ranges(source):
        while j < len(covered) and covered[j][1] <= start:
            j += 1
        k = j
        while k < len(covered) and covered[k][0] < end:
            a, b = covered[k]
            if a > start:
                result.append([start, min(a, end)])
            start = max(start, b)
            if start >= end:
                break
            k += 1
        if start < end:
            result.append([start, end])
    return result


def overlap(start, end, ranges):
    return sum(max(0, min(end, b) - max(start, a)) for a, b in ranges)


def normalize(text):
    return "".join(
        c
        for c in unicodedata.normalize("NFKC", text).casefold()
        if unicodedata.category(c)[0] in ("L", "N")
    )


def text_units(words):
    """Compare letters/digits, not whitespace tokenization (also works for CJK)."""
    units, owners = [], []
    for index, word in enumerate(words):
        for char in normalize(word.get("word", "")):
            units.append(char)
            owners.append(index)
    return units, owners


_SCALARS = frozenset((str, int, float, bool, type(None)))


def _copy_word(word):
    # Words are flat dicts of scalars, so a shallow copy is a full copy and ~7x
    # cheaper than deepcopy. That matters: this runs for every word of the
    # transcript (10^5 on a ten hour recording) each time it is flattened.
    # Anything that is not a plain scalar still gets the deep copy.
    copied = dict(word)
    if _SCALARS.issuperset(map(type, copied.values())):
        return copied
    return copy.deepcopy(word)


def flatten_words(segments):
    words = []
    for segment in segments:
        for word in segment.get("words", []):
            a, b = word.get("start"), word.get("end")
            if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
                continue
            if not math.isfinite(a + b) or b < a:
                continue
            if not str(word.get("word", "")).strip():
                continue
            words.append(_copy_word(word))
    return words


def _missing_and_overlap(covered, ends, start, end):
    """What subtract_ranges([(start, end)], covered) and overlap(start, end,
    covered) return, looking only at the covered ranges that touch the span.

    `covered` must be merged (sorted, disjoint) and `ends` its end points. The
    general helpers re-merge and re-sum the whole list on every call, which made
    the candidate scan quadratic in the length of the recording.
    """
    missing = []
    for s, e in merge_ranges([(start, end)]):
        k = bisect.bisect_right(ends, s)
        while k < len(covered) and covered[k][0] < e:
            a, b = covered[k]
            if a > s:
                missing.append([s, min(a, e)])
            s = max(s, b)
            if s >= e:
                break
            k += 1
        if s < e:
            missing.append([s, e])
    if not missing:
        return missing, 0
    seconds, k = 0, bisect.bisect_right(ends, start)
    while k < len(covered) and covered[k][0] < end:
        a, b = covered[k]
        seconds += max(0, min(end, b) - max(start, a))
        k += 1
    return missing, seconds


def find_candidates(segments, speech, duration):
    words = flatten_words(segments)
    # Partial word metadata must never make a whole recognised segment look empty.
    covered = [(s["start"], s["end"]) for s in segments if not s.get("words")]
    covered.extend((w["start"] - 0.2, w["end"] + 0.2) for w in words)
    covered = merge_ranges(covered)
    ends = [end for _, end in covered]
    gaps = []
    for start, end in speech:
        missing, covered_seconds = _missing_and_overlap(covered, ends, start, end)
        # Short standalone utterances deserve a check. Small differences at
        # the edge of an already transcribed sentence are alignment noise.
        standalone = covered_seconds < 0.05
        for a, b in missing:
            if b - a >= (0.1 if standalone else 0.7):
                gaps.append([a, b])
    groups = merge_ranges(gaps, 0.65)
    result = []
    for a, b in groups:
        while b - a > 16:
            result.append({"start": a, "end": a + 16, "kind": "speech"})
            a += 16
        result.append({"start": a, "end": min(duration, b), "kind": "speech"})
    # A word on the wrong side of a long silence is a timing issue, not missing text.
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


def _non_decreasing(values):
    return all(x <= y for x, y in zip(values, values[1:]))


class WordIndex:
    """A transcript flattened once, with its word times ready for lookups.

    Flattening copies every word, so doing it per candidate costs
    (candidates x words): minutes on a ten hour recording.
    """

    __slots__ = ("words", "starts", "ends", "ordered")

    def __init__(self, segments):
        self.words = flatten_words(segments)
        self.starts = [w["start"] for w in self.words]
        self.ends = [w["end"] for w in self.words]
        # Recognition output is time ordered. If a transcript is not, searching
        # by position would be wrong, so window_for scans every word instead.
        self.ordered = _non_decreasing(self.starts) and _non_decreasing(self.ends)


class WordIndexCache:
    """The WordIndex of the transcript a review is working on.

    The review replaces its transcript after a repair and never edits one in
    place, so an index stays valid for exactly as long as it is the same object.
    """

    def __init__(self):
        self._segments = None
        self._index = None

    def get(self, segments):
        if segments is not self._segments:
            self._index = WordIndex(segments)
            self._segments = segments
        return self._index


def window_for(candidate, duration, extra=0.0, segments=None):
    """Audio window to re-decode for a candidate. `segments` is a transcript,
    or a WordIndex of one when many windows are computed from the same text."""
    a, b = candidate["start"] - 5, candidate["end"] + 5
    if isinstance(segments, WordIndex):
        index = segments
    else:
        index = WordIndex(segments) if segments else None
    if index is not None:
        words = index.words
        if index.ordered:
            # Words ending before the candidate are a prefix, words starting
            # after it a suffix.
            left_count = bisect.bisect_right(index.ends, candidate["start"])
            right_first = bisect.bisect_left(index.starts, candidate["end"])
            left_word = words[max(0, left_count - 3)] if left_count else None
            right_word = (
                words[right_first + min(2, len(words) - right_first - 1)]
                if right_first < len(words)
                else None
            )
        else:
            left = [w for w in words if w["end"] <= candidate["start"]]
            right = [w for w in words if w["start"] >= candidate["end"]]
            left_word = left[max(0, len(left) - 3)] if left else None
            right_word = right[min(2, len(right) - 1)] if right else None
        # Include enough surrounding words to anchor across ordinary pauses.
        # Bound the context so a long silence cannot trigger a huge decode.
        if left_word is not None:
            a = min(a, max(candidate["start"] - 10, left_word["start"] - 0.4))
        if right_word is not None:
            b = max(b, min(candidate["end"] + 10, right_word["end"] + 0.4))
    return max(0, a - extra), min(duration, b + extra)


def confidence(words):
    if not words:
        return False
    probabilities = [
        w.get("probability") for w in words if normalize(w.get("word", ""))
    ]
    if not probabilities or any(
        not isinstance(p, (int, float)) or not math.isfinite(p) for p in probabilities
    ):
        return False
    return (
        sum(probabilities) / len(probabilities) >= 0.72 and min(probabilities) >= 0.12
    )


def propose_edit(original, decoded, candidate, speech, duration, suggestion_only=False):
    """Return one bounded, anchored change, or None. Original word indices are retained."""
    old = flatten_words(original)
    new = flatten_words(decoded)
    if not old or not new:
        return None
    start, end = candidate["start"], candidate["end"]
    # Restrict the matching search to the local timeline; repeated phrases elsewhere
    # must not become accidental anchors.
    indices = [
        i
        for i, w in enumerate(old)
        if w["end"] >= decoded[0]["start"] - 1 and w["start"] <= decoded[-1]["end"] + 1
    ]
    if not indices:
        return None
    offset = indices[0]
    local = old[offset : indices[-1] + 1]
    a, ao = text_units(local)
    b, bo = text_units(new)
    matcher = difflib.SequenceMatcher(None, a, b, autojunk=False)
    blocks = [block for block in matcher.get_matching_blocks() if block.size >= 4]
    # Use whole word boundaries at both ends of each anchor, not partial suffixes.
    anchors = []
    for block in blocks:
        ai, bi, size = block.a, block.b, block.size
        while size and ((ai and ao[ai - 1] == ao[ai]) or (bi and bo[bi - 1] == bo[bi])):
            ai += 1
            bi += 1
            size -= 1
        while size and (
            (ai + size < len(ao) and ao[ai + size] == ao[ai + size - 1])
            or (bi + size < len(bo) and bo[bi + size] == bo[bi + size - 1])
        ):
            size -= 1
        if size >= 4:
            anchors.append(
                (ao[ai], ao[ai + size - 1] + 1, bo[bi], bo[bi + size - 1] + 1)
            )
    lefts = [x for x in anchors if new[x[3] - 1]["end"] <= start + 0.45]
    rights = [x for x in anchors if new[x[2]]["start"] >= end - 0.45]
    if not lefts or not rights:
        return None
    left, right = lefts[-1], rights[0]
    oi, oj = left[1] + offset, right[0] + offset
    ni, nj = left[3], right[2]
    if oi > oj or ni >= nj or nj - ni > 70:
        return None
    replacement = new[ni:nj]
    if not confidence(replacement):
        return None
    lower = old[oi - 1]["end"] if oi else 0
    upper = old[oj]["start"] if oj < len(old) else duration
    # Timestamp errors in neighbouring anchors can overlap the true missing words.
    # Include an identical anchor word when needed so it can be realigned safely.
    while (
        replacement
        and replacement[-1]["end"] > upper + 0.08
        and oj < len(old)
        and nj < len(new)
    ):
        if normalize(old[oj]["word"]) != normalize(new[nj]["word"]):
            return None
        replacement.append(copy.deepcopy(new[nj]))
        oj += 1
        nj += 1
        upper = old[oj]["start"] if oj < len(old) else duration
    while replacement and replacement[0]["start"] < lower - 0.08 and oi > 0 and ni > 0:
        if normalize(old[oi - 1]["word"]) != normalize(new[ni - 1]["word"]):
            return None
        oi -= 1
        ni -= 1
        replacement.insert(0, copy.deepcopy(new[ni]))
        lower = old[oi - 1]["end"] if oi else 0
    if replacement[0]["start"] < lower - 0.08 or replacement[-1]["end"] > upper + 0.08:
        return None
    # The tolerance allows slight disagreement at anchors, not overlapping
    # output cues. Clamp the edited edge without moving untouched neighbours.
    replacement = copy.deepcopy(replacement)
    replacement[0]["start"] = max(lower, replacement[0]["start"])
    replacement[-1]["end"] = min(upper, replacement[-1]["end"])
    if not suggestion_only and (
        replacement[0]["start"] < start - 3 or replacement[-1]["end"] > end + 4
    ):
        return None
    content = normalize("".join(w["word"] for w in replacement))
    old_content = normalize("".join(w["word"] for w in old[oi:oj]))
    if not content or content == old_content:
        return None
    # Review recovers omitted content; a same-length substitution (e.g. In -> At)
    # is ordinary proofreading and must not count as a recovered omission.
    if (not suggestion_only and len(content) <= len(old_content)) or len(content) > 350:
        return None
    # New words need independent speech support (padding may include a little silence).
    # VAD onset/offset and word alignment differ slightly, especially for
    # interjections. Allow the same 200 ms boundary tolerance as word coverage.
    supported = merge_ranges(
        (max(0, a - 0.2), min(duration, b + 0.2)) for a, b in speech
    )
    if (
        overlap(replacement[0]["start"], replacement[-1]["end"], supported)
        < 0.15 - 1e-6
    ):
        return None
    if len(content) > 24 and len(set(content)) < 5:
        return None
    if any(w["end"] <= w["start"] for w in replacement):
        return None
    if any(
        replacement[i + 1]["start"] < w["end"] - 0.03
        for i, w in enumerate(replacement[:-1])
    ):
        return None
    if not confidence(replacement):
        return None
    return {
        "start_index": oi,
        "end_index": oj,
        "words": replacement,
        "start": replacement[0]["start"],
        "end": replacement[-1]["end"],
        "original": "".join(w["word"] for w in old[oi:oj]),
        "text": "".join(w["word"] for w in replacement),
    }


def agree_edits(first, second):
    return bool(
        first
        and second
        and first["start_index"] == second["start_index"]
        and first["end_index"] == second["end_index"]
        and normalize(first["text"]) == normalize(second["text"])
        and abs(first["start"] - second["start"]) <= 0.7
        and abs(first["end"] - second["end"]) <= 0.7
    )


def propose_short_retime(segments, decoded, candidate, speech, duration, suggestion_only=False):
    """Locate an isolated short cue using unchanged, uniquely matched neighbours.

    Only an unsupported old position can move, within its original neighbours.
    The caller must confirm the location using a different decode window.
    """
    old, new = flatten_words(segments), flatten_words(decoded)
    old_tokens = [normalize(w["word"]) for w in old]
    new_tokens = [normalize(w["word"]) for w in new]
    cursor, proposals = 0, []
    for index, segment in enumerate(segments):
        group = segment.get("words", [])
        start_index, cursor = cursor, cursor + len(group)
        if (
            not 1 <= len(group) <= 2
            or not 0 < segment["end"] - segment["start"] <= 1.5
            or not 1 <= len(normalize(segment["text"])) <= 24
            or not 0 < index < len(segments) - 1
            or segment["end"] < candidate["start"] - 10
            or segment["start"] > candidate["end"] + 10
        ):
            continue
        # Require context on both sides, including complete tokens. A repeated
        # sequence nearby is ambiguous and must never be resolved by proximity.
        left, right = max(0, start_index - 3), min(len(old), cursor + 3)
        if (
            start_index - left < 2 or right - cursor < 2
            or len("".join(old_tokens[left:start_index])) < 4
            or len("".join(old_tokens[cursor:right])) < 4
        ):
            continue
        sequence = old_tokens[left:right]
        if any(not token for token in sequence):
            continue
        matches = [j for j in range(len(new) - len(sequence) + 1)
                   if new_tokens[j:j + len(sequence)] == sequence]
        old_matches = [j for j in range(len(old) - len(sequence) + 1)
                       if abs(old[j]["start"] - segment["start"]) <= 12
                       and old_tokens[j:j + len(sequence)] == sequence]
        if len(matches) != 1 or len(old_matches) != 1:
            continue
        ni = matches[0] + start_index - left
        nj = ni + len(group)
        replacement = copy.deepcopy(new[ni:nj])
        a, b = replacement[0]["start"], replacement[-1]["end"]
        lower, upper = segments[index - 1]["end"], segments[index + 1]["start"]
        if not suggestion_only:
            # Alignment can differ slightly at a shared boundary. Use the same
            # 80 ms tolerance as other repairs, but never output an overlap.
            if a < lower - .08 or b > upper + .08:
                continue
            replacement[0]["start"] = a = max(a, lower)
            replacement[-1]["end"] = b = min(b, upper)
        if (
            not confidence(new[matches[0]:matches[0] + len(sequence)])
            or not 0 < b - a <= 1.5
            or not 0.8 <= abs(a - segment["start"]) <= 8
            or not 0.8 <= abs(b - segment["end"]) <= 8
            or overlap(a, b, [(candidate["start"] - .6, candidate["end"] + .6)]) <= 0
            or (not suggestion_only and overlap(segment["start"], segment["end"], speech)
                >= (segment["end"] - segment["start"]) * .5)
            or overlap(a, b, merge_ranges((max(0, x - .2), min(duration, y + .2))
                                         for x, y in speech)) < .12
        ):
            continue
        # Adjacent anchors must retain their original timing; only the isolated
        # cue may jump across the pause. Never move it across another subtitle.
        if any(abs(new[n][edge] - old[o][edge]) > .7
               for n, o in [(ni - 1, start_index - 1), (nj, cursor)]
               for edge in ("start", "end")):
            continue
        if any(w["end"] <= w["start"] for w in replacement) or any(
            r["start"] < l["end"] for l, r in zip(replacement, replacement[1:])
        ):
            continue
        for previous, word in zip(group, replacement):
            word["word"] = previous["word"]
        proposals.append({
            "segment_index": index, "start": a, "end": b,
            "originalStart": segment["start"], "originalEnd": segment["end"],
            "text": segment["text"], "words": replacement,
        })
    return proposals[0] if len(proposals) == 1 else None


def agree_short_retimes(first, second):
    return bool(first and second
                and first["segment_index"] == second["segment_index"]
                and first["text"] == second["text"]
                and abs(first["start"] - second["start"]) <= .35
                and abs(first["end"] - second["end"]) <= .35)


def apply_short_retime(segments, proposal):
    result = copy.deepcopy(segments)
    segment = result[proposal["segment_index"]]
    segment.update({k: copy.deepcopy(proposal[k]) for k in ("start", "end", "words")})
    return result


def apply_edit(segments, edit):
    """Preserve unmodified segment boundaries/text; split only the edited neighbours."""
    result, cursor, inserted = [], 0, False

    def append_words(words):
        if words:
            group = []
            for word in words:
                if group and (
                    word["start"] - group[-1]["end"] > 0.7
                    or word["end"] - group[0]["start"] > 8
                ):
                    result.append(
                        {
                            "start": group[0]["start"],
                            "end": group[-1]["end"],
                            "text": "".join(w["word"] for w in group),
                            "words": copy.deepcopy(group),
                        }
                    )
                    group = []
                group.append(word)
            if group:
                result.append(
                    {
                        "start": group[0]["start"],
                        "end": group[-1]["end"],
                        "text": "".join(w["word"] for w in group),
                        "words": copy.deepcopy(group),
                    }
                )

    for segment in segments:
        words = segment.get("words", [])
        next_cursor = cursor + len(words)
        a, b = edit["start_index"], edit["end_index"]
        if next_cursor <= a or cursor >= b:
            if not inserted and cursor >= b:
                append_words(edit["words"])
                inserted = True
            result.append(copy.deepcopy(segment))
        else:
            append_words(words[: max(0, a - cursor)])
            if not inserted:
                append_words(edit["words"])
                inserted = True
            append_words(words[max(0, b - cursor) :])
        cursor = next_cursor
    if not inserted:
        append_words(edit["words"])
    return sorted(result, key=lambda s: (s["start"], s["end"]))
