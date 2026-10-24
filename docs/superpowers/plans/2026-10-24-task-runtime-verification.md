# Task runtime verification

Implementation branch: `codex/task-runtime-refactor`, based on `d68b0a0a`.
All six phases of the approved task runtime plan are implemented. Phases 3–5
were integrated together because queue execution, artifact commits and reuse
share the same stage boundary.

## Verified behavior

- Accepted configuration and input bindings are immutable; main-process commands
  and draft revisions reject stale or conflicting updates.
- Pause yields after the current stage; cancellation fences late results; failed
  attempts retry within the original run. Queue drain uses run aggregation.
- New runs reevaluate every file, hash complete inputs and reuse only validated
  automatic artifacts from the previous run. Formatting is separate from paid
  translation. Changed dependencies invalidate descendants.
- Artifact bundles preserve distinct same-named files and deduplicate repeated
  references. Editable sidecars and dubbing sessions are independent of history.
- Manual subtitle changes save before release. Active writes block release,
  replacement runs and retry/resume. Dubbing approval precedes track construction.
- History, next-run drafts, input rebinding, safe output names and deletion recovery
  were exercised in the production Electron application with isolated profiles.
- Legacy history is read-only, marked with incomplete configuration and excluded
  from trusted caching and new-run execution. Legacy continuation remains isolated.

## Checks

| Check                                 | Result                                                             |
| ------------------------------------- | ------------------------------------------------------------------ |
| `npm run test:task-runs`              | 29 passed                                                          |
| `npm run test:stage-artifacts`        | 6 passed                                                           |
| `npm run test:stage-cache`            | 4 passed                                                           |
| `npm run test:pro-baseline`           | 44 test commands passed                                            |
| `npm run test:summary`                | 307 passed                                                         |
| `npm run test:engines`                | 1127 unit checks plus worker/runtime/WAV/Qwen regressions passed   |
| `npm run test:automation:regressions` | Passed                                                             |
| `npm run typecheck`                   | Renderer, main, automation and crash scripts passed                |
| `npm run build`                       | Renderer, main, CLI and MCP build passed                           |
| `npm run test:e2e:task-runs`          | Lifecycle/history, presentation and manual-review scenarios passed |
| `git diff --check`                    | Passed                                                             |

The new presentation acceptance asserts exactly one local translation request
across layout, bilingual-order and punctuation changes, and checks formatting
after a real proofreading save. Manual-review acceptance edits through the UI,
releases the gate without separately clicking Save, checks the text sent to the
local TTS fixture, verifies durable session input, and builds the audio only after
dubbing approval.

An independent whole-branch review found eight important issues initially. The
verified fixes and follow-up findings are included in this branch. The reviewer
reran all 39 focused tests and the production presentation scenario independently;
the final review reported no remaining critical or important findings.

## Coverage limits

Tests use generated media and local deterministic HTTP fixtures, with no paid
service calls. Real cloud accounts, native ASR inference, and all platform/GPU
combinations require their corresponding environments. The engine adapters and
their resource locks remain in use. No automatic artifact eviction is introduced;
retained history can grow disk usage. External Whisper CLI implementations are
not eligible for cross-run ASR reuse because their implementation identity cannot
be established reliably.
