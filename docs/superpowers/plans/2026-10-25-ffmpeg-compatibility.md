# FFmpeg Compatibility Implementation Plan

> **For agentic workers:** Use test-driven implementation for each task, and an independent whole-branch review before completion. Independent toolbox and audio tasks may run in parallel with disjoint file ownership.

**Goal:** Repair the audited FFmpeg compatibility problems together with the existing working-tree fix, on `fix/ffmpeg-compatibility`.

**Architecture:** Keep the existing command builders/runners. Share small video encoding constants and stream conversion policies; extend media probing with actual audio codecs and pixel format. Make first-audio-stream selection explicit across audio consumers.

**Tech Stack:** TypeScript, Node, fluent-ffmpeg, bundled ffmpeg-static, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-25-ffmpeg-compatibility-design.md`

## Global Constraints

- No new runtime dependency, source-file overwrite, release, or main-branch merge.
- Preserve the existing ASS path fix and compose publication/cancellation behavior.
- Use bundled FFmpeg for real regression tests on macOS and Windows.
- Audio analysis/extraction/waveform use the first audio stream consistently.
- Existing compatible streams and native ASS styles/attachments should be preserved.

## Review Focus

- Mixed compatible/incompatible audio tracks need per-track codec options.
- Embedded subtitle indices differ when a new subtitle is prepended.
- Silent inputs, attached pictures, and native ASS positioning must remain usable.
- Multiple audio/subtitle tracks must survive lossless trimming.
- Windows drive letters, apostrophes, Unicode and filter punctuation need actual execution.

## Task 1: Compose stream compatibility and CPU format

Files: `main/helpers/compose/{composeCommandBuilder,composeRunner}.ts`, shared `main/helpers/mediaStreamCompatibility.ts`, existing subtitle path fix and compose tests.

- [x] Add real failing regressions for mov_text MP4 to MKV, PCM MKV to MP4, mixed audio tracks, and CPU translated ASS pixel format.
- [x] Add `audioCodecs?: string[]` to compose input; consume probe metadata and apply per-output audio/subtitle codec options.
- [x] Probe embedded subtitles for all branches that preserve them; preserve original ASS and reject bitmap-to-MP4 remuxes.
- [x] Fix CPU output pixel format using shared video constants; preserve path regression.
- [x] Run compose builder/output/canvas suites and typecheck.

## Task 2: Toolbox containers, dimensions and stream preservation

Files: `main/helpers/toolbox/{videoTrimmer,videoCompressor}.ts`, shared `main/helpers/videoEncoding.ts`, toolbox tests and necessary UI path handling.

Interfaces: `probeVideoInfo` adds `audioCodecs: string[]` and `pixelFormat?: string`; `videoEncoding.ts` exports `COMPATIBLE_PIXEL_FORMAT`, `EVEN_DIMENSIONS_CROP_FILTER`, `EVEN_DIMENSIONS_PAD_FILTER`.

- [x] Capture failing accurate WebM, odd yuv420p, multi-track lossless trim, and yuv444p compressor cases.
- [x] Normalize accurate output containers, map intended streams, apply even dimensions and yuv420p; improve compressor skip predicate.
- [x] Test real FFmpeg outputs and existing toolbox unit/UI contracts.

## Task 3: Consistent audio stream selection

Files: audioProcessor, cloneAudioPipeline, proofreadWaveform and relevant audio helpers/tests.

- [x] Reproduce clone analysis/finalization and waveform/extraction mismatches with distinct multi-track audio.
- [x] Explicitly select first audio consistently through extraction, analysis and finalization.
- [x] Verify signal identity, silence behavior, existing clone/waveform suites and special paths.

## Task 4: Integration, review and Windows CI

Files: package scripts and `.github/workflows/ffmpeg-compatibility.yml`.

- [x] Add a focused portable real-FFmpeg regression command and CI matrix (Windows and Linux).
- [x] Run relevant local suites and typecheck; review the complete branch and address findings.
- [x] Commit and push this branch; run Windows CI and inspect/fix failures until green.
- [x] Report branch, commits, tested platforms and CI links. Keep main unmerged.

## Verification record

- Branch: `fix/ffmpeg-compatibility`; tested code/test/workflow commit: `06d2ecc402ff382d4577ecc81644b2b3571d4a5d`.
- Local macOS: the 35 new regressions (11 compose, 17 toolbox, 7 audio), relevant existing suites and full typecheck passed.
- [Windows 2022 and Ubuntu 22.04 CI](https://github.com/buxuku/SmartSub/actions/runs/40203373283): both jobs succeeded, including the new regressions, existing compose/output/canvas/toolbox/waveform/audio-cache/voice-clone suites and full typecheck.
- Independent branch review passed after fixing unknown-duration compose inputs and preserving MKV font attachments during audio replacement/mixing. Real-media regressions cover both findings.
- Windows CI also exposed two existing test portability problems: POSIX-only expected temp paths and unescaped drive paths in canvas fixtures. Both test entry points are fixed; actual application path escaping remains exercised through the real compose runner.

## Remaining verification limits and separate timing issue

- Hosted CI does not validate successful NVENC/QSV encoding on real GPUs; the compose suite does exercise fallback to CPU when the requested encoder is unavailable.
- An existing accurate-trim timing issue was reproduced in both the base and updated commands: copying a subtitle event that begins before the trim start can omit that overlapping event. Repairing subtitle-event clipping is outside this parameter/container compatibility change; it remains unresolved.
