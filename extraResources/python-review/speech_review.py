"""Automatic local second pass using the installed faster-whisper runtime.

No thresholds in the first pass are changed. The additional VAD only chooses
bounded review windows; decoding uses the original waveform including silence.
"""

import copy
import logging
import time
import wave

from review_core import (
    agree_edits,
    apply_edit,
    confidence,
    find_candidates,
    flatten_words,
    merge_ranges,
    normalize,
    overlap,
    propose_edit,
    propose_short_retime,
    agree_short_retimes,
    apply_short_retime,
    window_for,
)

log = logging.getLogger(__name__)


class ReviewCancelled(Exception):
    pass


def check_cancel(cancelled):
    if cancelled():
        raise ReviewCancelled()


def read_audio(path, start=0, end=None):
    import numpy as np

    with wave.open(path) as source:
        if (
            source.getnchannels() != 1
            or source.getframerate() != 16000
            or source.getsampwidth() != 2
        ):
            raise ValueError("Speech review expects PCM16 mono 16kHz WAV")
        duration = source.getnframes() / 16000
        start = max(0, min(start, duration))
        end = duration if end is None else min(duration, end)
        source.setpos(round(start * 16000))
        return (
            np.frombuffer(
                source.readframes(max(0, round((end - start) * 16000))), dtype="<i2"
            ).astype("float32")
            / 32768,
            duration,
        )


def scan_speech(path, cancelled, progress):
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    with wave.open(path) as source:
        duration = source.getnframes() / source.getframerate()
    intervals, brief = [], []
    # Bounded reads, overlap for VAD state at boundaries. Review-only sensitivity
    # recovers brief utterances without feeding every click/music peak to Whisper.
    for start in range(0, max(1, int(duration) + 1), 60):
        check_cancel(cancelled)
        offset = max(0, start - 1)
        audio, _ = read_audio(path, offset, min(duration, start + 61))
        spans = get_speech_timestamps(
            audio,
            VadOptions(
                threshold=0.35,
                min_speech_duration_ms=100,
                min_silence_duration_ms=100,
                speech_pad_ms=0,
            ),
        )
        # A brief interjection can be absorbed by a neighbouring word's bad
        # timestamp. Examine short VAD pulses even when the word timeline covers
        # them. These are candidates only; both local decodes must still agree.
        pulses = get_speech_timestamps(
            audio,
            VadOptions(
                threshold=0.5,
                min_speech_duration_ms=0,
                min_silence_duration_ms=100,
                speech_pad_ms=0,
            ),
        )
        brief.extend(
            (offset + s["start"] / 16000, offset + s["end"] / 16000)
            for s in pulses
            if 0.06 <= (s["end"] - s["start"]) / 16000 < 0.25
            and start <= offset + s["start"] / 16000 < start + 60
        )
        intervals.extend(
            (
                max(start, offset + s["start"] / 16000),
                min(start + 60, duration, offset + s["end"] / 16000),
            )
            for s in spans
            if offset + s["end"] / 16000 > start
            and offset + s["start"] / 16000 < start + 60
        )
        progress(min(1, (start + 60) / max(duration, 1)))
    return merge_ranges(intervals, 0.08), duration, merge_ranges(brief)


def decode_window(model, audio_path, start, end, language, cancelled, params=None):
    check_cancel(cancelled)
    audio, _ = read_audio(audio_path, start, end)
    params = params or {}
    # Preserve vocabulary and explicit anti-hallucination constraints.
    extra = {
        key: params[key]
        for key in (
            "initial_prompt",
            "repetition_penalty",
            "no_repeat_ngram_size",
            "compression_ratio_threshold",
            "log_prob_threshold",
            "no_speech_threshold",
            "hallucination_silence_threshold",
        )
        if params.get(key) is not None
    }
    iterator, _ = model.transcribe(
        audio,
        language=language,
        vad_filter=False,
        word_timestamps=True,
        condition_on_previous_text=False,
        temperature=0,
        beam_size=5,
        **extra
    )
    segments = []
    for s in iterator:
        check_cancel(cancelled)
        segments.append(
            {
                "start": round(s.start + start, 3),
                "end": round(s.end + start, 3),
                "text": s.text,
                "avg_logprob": s.avg_logprob,
                "no_speech_prob": s.no_speech_prob,
                "words": [
                    {
                        "start": round(w.start + start, 3),
                        "end": round(w.end + start, 3),
                        "word": w.word,
                        "probability": w.probability,
                    }
                    for w in (s.words or [])
                ],
            }
        )
    return segments


def retime_segment(segments, decoded, candidate):
    """Exact text match only: no word may be added or removed by timing repair."""
    if candidate["kind"] != "timing":
        return None
    new_words = flatten_words(decoded)
    for index, s in enumerate(segments):
        if not (s["start"] <= candidate["start"] and s["end"] >= candidate["end"]):
            continue
        old_words = s.get("words", [])
        content = normalize(s["text"])
        for left in range(len(new_words)):
            text = ""
            for right in range(left, min(len(new_words), left + len(old_words) + 8)):
                text += new_words[right]["word"]
                normalized = normalize(text)
                if normalized == content:
                    replacement = new_words[left : right + 1]
                    if not confidence(replacement):
                        return None
                    # Timing repair must retain original punctuation, casing and
                    # tokenization as well as normalized text. CJK token splits
                    # may differ; those cases stay unchanged for manual review.
                    if len(replacement) != len(old_words) or any(
                        normalize(old["word"]) != normalize(new["word"])
                        for old, new in zip(old_words, replacement)
                    ):
                        return None
                    replacement = [
                        {**new, "word": old["word"]}
                        for old, new in zip(old_words, replacement)
                    ]
                    a, b = replacement[0]["start"], replacement[-1]["end"]
                    if a < s["start"] - 0.2 or b > s["end"] + 0.4:
                        return None
                    if (
                        any(w["end"] <= w["start"] for w in replacement)
                        or any(
                            r["start"] < l["end"] - 0.03
                            for l, r in zip(replacement, replacement[1:])
                        )
                        or (index and a < segments[index - 1]["end"] - 0.08)
                        or (
                            index + 1 < len(segments)
                            and b > segments[index + 1]["start"] + 0.08
                        )
                    ):
                        return None
                    replacement = copy.deepcopy(replacement)
                    if index:
                        replacement[0]["start"] = max(a, segments[index - 1]["end"])
                    if index + 1 < len(segments):
                        replacement[-1]["end"] = min(b, segments[index + 1]["start"])
                    if any(w["end"] <= w["start"] for w in replacement):
                        return None
                    a, b = replacement[0]["start"], replacement[-1]["end"]
                    result = copy.deepcopy(segments)
                    result[index] = {**s, "start": a, "end": b, "words": replacement}
                    return result
                if len(normalized) > len(content):
                    break
    return None


def review(model, result, params, emit, cancelled):
    started = time.monotonic()
    original = result.get("segments") or []
    # Incomplete metadata is a capability limitation, not an apparent omission.
    if any(
        normalize(s.get("text", ""))
        != normalize("".join(w.get("word", "") for w in s.get("words", [])))
        for s in original
    ) or (
        len(flatten_words(original)) != sum(len(s.get("words", [])) for s in original)
    ):
        return {
            **result,
            "speechReview": {"status": "unavailable", "reason": "word_timeline"},
        }
    emit("review", {"stage": "checking", "completed": 0, "total": 0})
    speech, duration, brief = scan_speech(
        params["audio_file"],
        cancelled,
        lambda p: emit("progress", {"percent": 90 + p * 2}),
    )
    current = copy.deepcopy(original)
    candidates = find_candidates(current, speech, duration)
    for a, b in brief:
        if not any(
            c["kind"] == "speech" and overlap(a, b, [(c["start"], c["end"])]) > 0
            for c in candidates
        ):
            candidates.append({"start": a, "end": b, "kind": "speech", "brief": True})
    # Preserve the existing primary order and allowance. New short-cue timing
    # confirmations run only after this queue, with their own bounded allowance.
    candidates.sort(
        key=lambda c: (
            (
                0
                if c["kind"] == "speech" and c["end"] - c["start"] >= 0.8
                else 1 if c["kind"] == "speech" else 2
            ),
            -(c["end"] - c["start"]),
        )
    )
    budget = min(600, max(60, duration * 0.12))
    consumed = 0.0
    short_timing_budget = min(60, max(20, duration * 0.02))
    short_timing_consumed, short_timing_confirmations = 0.0, 0
    deferred_timing, skipped = [], []
    recovered, retimed, checked, unresolved = [], [], [], []
    total = min(24, len(candidates))
    for candidate in candidates:
        check_cancel(cancelled)
        a, b = window_for(candidate, duration, segments=current)
        if len(checked) >= 24 or consumed + (b - a) > budget:
            skipped.append({**candidate, "reason": "candidate_limit" if len(checked) >= 24 else "audio_budget"})
            if candidate["kind"] == "speech" and not candidate.get("brief"):
                unresolved.append({**candidate, "reason": "budget"})
            continue
        # Previous repairs may have already filled an adjacent candidate.
        if candidate["kind"] == "speech" and not candidate.get("brief"):
            remaining = find_candidates(current, speech, duration)
            if not any(
                r["kind"] == "speech"
                and overlap(
                    candidate["start"], candidate["end"], [(r["start"], r["end"])]
                )
                >= min(0.12, (candidate["end"] - candidate["start"]) * 0.8)
                for r in remaining
            ):
                continue
        emit(
            "review", {"stage": "reviewing", "completed": len(checked), "total": total}
        )
        first = decode_window(
            model, params["audio_file"], a, b, result.get("language"), cancelled, params
        )
        consumed += b - a
        checked.append({**candidate, "window": [a, b], "decoded": first})
        if candidate["kind"] == "timing":
            updated = retime_segment(current, first, candidate)
            if updated:
                current = updated
                retimed.append(candidate)
        else:
            timing = propose_short_retime(current, first, candidate, speech, duration)
            if timing:
                deferred_timing.append(checked[-1])
                emit("progress", {"percent": 92 + min(1, len(checked) / max(1, total)) * 7})
                continue
            proposal = propose_edit(current, first, candidate, speech, duration)
            if proposal:
                c, d = window_for(candidate, duration, 2, current)
                reason = "budget"
                independent = abs(c - a) + abs(d - b) >= 0.5
                if not independent:
                    reason = "context"
                if independent and consumed + d - c <= budget:
                    second = decode_window(
                        model,
                        params["audio_file"],
                        c,
                        d,
                        result.get("language"),
                        cancelled,
                        params,
                    )
                    consumed += d - c
                    checked[-1]["confirmation"] = second
                    checked[-1]["confirmationWindow"] = [c, d]
                    reason = "disagreement"
                    confirmation = propose_edit(
                        current, second, candidate, speech, duration
                    )
                    if agree_edits(proposal, confirmation):
                        current = apply_edit(current, proposal)
                        recovered.append({**candidate, **proposal})
                        log.info(
                            "speech review recovered %.2f-%.2f (%d words)",
                            proposal["start"],
                            proposal["end"],
                            len(proposal["words"]),
                        )
                        continue
                unresolved.append(
                    {
                        **candidate,
                        "reason": reason,
                        "suggestedText": proposal["text"],
                        **({"issue": "text", "originalText": proposal["original"]}
                           if normalize(proposal["original"]) else {}),
                    }
                )
            else:
                # Explicit anchored differences remain useful even when too short
                # or badly aligned for automatic editing. Do not warn for every pulse.
                suggestion = propose_edit(
                    current, first, candidate, speech, duration, suggestion_only=True,
                )
                timing_hint = propose_short_retime(
                    current, first, candidate, speech, duration, suggestion_only=True,
                ) if not suggestion else None
                if timing_hint:
                    unresolved.append({
                        **candidate, "start": timing_hint["start"], "end": timing_hint["end"],
                        "reason": "unconfirmed", "issue": "timing", "suggestedText": timing_hint["text"],
                    })
                elif suggestion or not candidate.get("brief") or not original:
                    unresolved.append(
                        {
                            **candidate,
                            "reason": "unconfirmed",
                            **(
                                {"suggestedText": suggestion["text"]}
                                if suggestion
                                else {}
                            ),
                            **({"issue": "text", "originalText": suggestion["original"]}
                               if suggestion and normalize(suggestion["original"]) else {}),
                        }
                    )
        emit("progress", {"percent": 92 + min(1, len(checked) / max(1, total)) * 7})
    for check in deferred_timing:
        check_cancel(cancelled)
        candidate = {k: check[k] for k in ("start", "end", "kind", "brief") if k in check}
        # Primary text edits may split cues or change indices. Re-anchor against
        # the final primary output, never apply a stale segment_index.
        timing = propose_short_retime(current, check["decoded"], candidate, speech, duration)
        reason = "unconfirmed"
        if timing:
            a, b = check["window"]
            c, d = window_for(candidate, duration, 2, current)
            independent = abs(c - a) + abs(d - b) >= .5
            reason = "budget" if independent else "context"
            if (independent and short_timing_confirmations < 4
                    and short_timing_consumed + d - c <= short_timing_budget):
                second = decode_window(
                    model, params["audio_file"], c, d,
                    result.get("language"), cancelled, params,
                )
                short_timing_consumed += d - c
                short_timing_confirmations += 1
                check["confirmation"] = second
                check["confirmationWindow"] = [c, d]
                check["confirmationPurpose"] = "shortTiming"
                confirmation = propose_short_retime(current, second, candidate, speech, duration)
                reason = "disagreement"
                if agree_short_retimes(timing, confirmation):
                    current = apply_short_retime(current, timing)
                    retimed.append({**candidate, **timing})
                    continue
        else:
            timing = propose_short_retime(
                current, check["decoded"], candidate, speech, duration, suggestion_only=True,
            )
        if timing:
            unresolved.append({
                **candidate, "start": timing["start"], "end": timing["end"],
                "reason": reason, "issue": "timing", "suggestedText": timing["text"],
            })
    check_cancel(cancelled)
    summary = {
        "status": "complete",
        "checked": len(checked),
        "recovered": len(recovered),
        "retimed": len(retimed),
        "pending": len(unresolved),
        "seconds": round(time.monotonic() - started, 2),
        "changes": recovered,
        "timingChanges": [r for r in retimed if "originalStart" in r],
        "unresolved": unresolved,
        "budget": {
            "primaryLimitSeconds": budget,
            "primaryUsedSeconds": round(consumed, 3),
            "primaryCandidateLimit": 24,
            "shortTimingLimitSeconds": short_timing_budget,
            "shortTimingUsedSeconds": round(short_timing_consumed, 3),
            "shortTimingConfirmationLimit": 4,
            "shortTimingConfirmations": short_timing_confirmations,
        },
        "skippedChecks": skipped,
    }
    summary["checks"] = checked
    emit(
        "review",
        {
            "stage": "complete",
            "completed": len(checked),
            "total": total,
            "recovered": len(recovered),
            "retimed": len(retimed),
            "pending": len(unresolved),
        },
    )
    log.info(
        "speech review complete: checked=%d recovered=%d retimed=%d pending=%d seconds=%.1f",
        len(checked),
        len(recovered),
        len(retimed),
        len(unresolved),
        summary["seconds"],
    )
    return {
        **result,
        "segments": current,
        "reviewSpeechSegments": [{"start": a, "end": b} for a, b in speech],
        "speechReview": summary,
        "beforeReviewSegments": original,
    }
