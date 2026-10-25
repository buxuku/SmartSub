# FFmpeg compatibility repair

The user authorized one new branch containing the existing subtitle-path fix and all eight findings from the FFmpeg audit, including Windows CI verification.

## Behavior

- Preserve the two-level ASS path escaping fix, including quotes and non-ASCII Windows temp directories.
- Preserve embedded subtitle tracks across compose container changes; convert only incompatible text codecs and reject unsupported bitmap/container combinations before encoding.
- Inspect actual audio codecs when deciding whether MP4-family outputs can copy original audio. Preserve already compatible tracks and transcode incompatible tracks to AAC.
- Accurate WebM/Ogg trimming produces a compatible container. Lossless trimming preserves streams; accurate trimming preserves supported audio/subtitle streams with explicit mappings.
- H.264 encoding receives even dimensions and a deliberate 8-bit 4:2:0 pixel format. Compose retains its existing one-pixel crop behavior; toolbox accurate trimming pads instead of losing source pixels.
- Audio extraction, clone analysis/finalization, and proofread waveforms consistently use the first audio stream. This matches the existing waveform contract without introducing a new track-selection UI.
- A compressor skip decision checks pixel format as well as container and codecs.

## Approach

Use small shared encoding/stream-policy helpers and extend the existing bundled-FFmpeg probe. Keep native FFmpeg argv arrays and existing runners. An FFmpeg version upgrade would not fix these application parameter bugs; replacing every runner would add unrelated churn.

## Constraints and verification

No new runtime dependency, no source-file overwrite, no release or main-branch merge. Preserve cancellation and output publication behavior. Test actual files with bundled FFmpeg, not only argument snapshots. Windows CI must execute the new regressions, including quote/non-ASCII paths, and finish successfully on the pushed branch. Hardware-specific NVENC/QSV success requires GPU hardware and is not implied by hosted Windows CI.
