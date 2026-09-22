# Automatic speech review validation

The app-owned Python wrapper calls the installed runtime unchanged for the first
pass, then checks a bounded set of local windows. No model is downloaded by these
scripts. Use a separate output directory; source WAVs, subtitles and app profiles
are never overwritten.

Fast checks:

```sh
npm run test:speech-review
npm run test:missed-speech
npm run test:renderer -- SpeechReview
npm run test:engines
npm run typecheck
npm run check:i18n
npm run build
node scripts/asr-review/ui-e2e.mjs
```

`ui-e2e.mjs` launches the production build with an isolated temporary profile.

Full integration (installed runtime, actual production adapter, SRT, word timeline,
audit record and final warnings):

```sh
node scripts/asr-review/run-engine.cjs --audio /path/input.wav \
  --runtime /path/faster-whisper --model /path/model-snapshot --output /path/artifacts
```

Use `--outcome accurate` for the current “Most accurate text” defaults; the default
is `balanced`. The production adapter resolves the preset. Dispatched parameters
are saved in `runtime-params.json`, with start/end times in `evaluation.json`.

`replay.py` applies the current review code to a saved runtime result (or the
original diagnostic `completed_task.json`), avoiding a new first pass:

```sh
/path/runtime/bin/python3 scripts/asr-review/replay.py \
  --baseline /path/raw-result.json --audio /path/input.wav \
  --model /path/model-snapshot --output /path/review.json
node scripts/asr-review/export-result.cjs --result /path/review.json \
  --audio /path/input.wav --output /path/export
```

If the saved result already includes a review, replay uses `beforeReviewSegments`
as the baseline. `--decode-cache /path/previous-review.json` reuses matching local
and confirmation windows; use only a cache from the same audio, model and decoding
settings. `--cache-only` fails if a required window is missing. Cached replay times
measure validation work, not fresh recognition performance; cache use and the
source review duration are recorded in `replayValidation`.

For a self-contained interpreter, set `PYTHONHOME` to its runtime directory and
`PYTHONPATH` to its `site-packages`. On Windows use `python.exe`.

`regression.py` compares first-pass text with reviewed text for the existing
`.longgap/audio/` English, Chinese and Japanese fixtures, their music variants,
and generated non-speech. `--cases en.quiet,en.repeat` adds quiet speech and
repeated sentences. `--reuse-baselines /path/previous-output` reuses saved initial
outputs so the comparison isolates review changes. Any textual change needs
inspection against the fixture source in `scripts/longgap/fixtures.ts`; unchanged
text alone does not establish correct timing or complete recall.

`runtime-cancel.py --runtime ... --model ... --audio ...` cancels when the installed
runtime enters review and verifies that the same process remains responsive.
Use the local tiny model for this protocol check; it does not measure large-v3
recognition quality.

The review audit records original segments, accepted changes, unconfirmed ranges
and local decode results. Two agreeing decodes are a safeguard, not proof of
correctness. Never use fewer warnings alone as the acceptance criterion.

Isolated one- or two-token cues can move only after two local windows agree,
their surrounding words match uniquely, and speech supports the new location.
Tiny boundary differences are clamped to unchanged neighbouring cues. Timing
repairs preserve the original text and appear in `timingChanges`, separately from
recovered content. Unconfirmed timing and wording differences remain review hints;
same-length or shorter wording suggestions never overwrite the original.

Short-cue timing confirmations run after the primary queue and cannot spend its
allowance (24 candidates and `min(600, max(60, duration * .12))` seconds of decoded
audio, including content confirmations). They have a separate allowance of at
most four confirmations and `min(60, max(20, duration * .02))` audio seconds.
Unused extra allowance is not transferred into the primary queue. Deferred cues
are re-anchored after primary edits, so insertion or splitting cannot invalidate
their indices. Exhausted or disagreeing confirmations remain timing hints.
The audit records both budgets, confirmation purpose, and skipped primary checks;
audio budgets do not promise a wall-clock runtime.

`validate-result.py --result /path/review.json --output /path/validation.json`
checks every text change against the edit audit, short-cue timing confirmations,
word/cue consistency, timestamp regressions, and both budget ledgers.
