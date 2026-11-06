# Unified task runs, stages and artifacts

Approved in the planning conversation on 2026-10-24, following issue #564.

## Intent and scope

Unify the lifecycle, execution configuration, stage plan and reusable artifacts of
subtitle generation/translation pipelines, including dubbing/composition, desktop,
automation, download handoffs and manual gates. Retain engine adapters, resource
locks and file concurrency. Do not rewrite standalone downloads/toolbox internals,
introduce a workflow framework/database, or implement cross-task caching.

The selected approach is incremental integration of a shared run/stage model. A
UI-only lock/cleanup fix does not solve provenance or independent status rules;
a wholesale workflow-engine rewrite has an unnecessary regression surface.

## Binding product decisions

- Deliver the complete solution in six verified phases, not only the first fix.
- A submitted run freezes its configuration, file list and input bindings. Editing
  is prohibited while preparing, queued, running, pausing, paused, cancelling or
  awaiting review. Completed/failed/cancelled tasks can edit their next-run draft.
- Continue and failed retry retain the same run/configuration. Cancellation ends
  the run; starting again creates a new run. Configuration changes create a new
  run and reevaluate **all** files, including previously completed files.
- Pause stops new dispatch and yields active files after the current stage, freeing
  concurrency slots. It does not interrupt an in-flight paid/model operation.
- Every new run streams SHA-256 over media inputs with progress/cancellation.
  Small external subtitle/manuscript inputs are snapshotted. Detect changes during
  reads; later external media changes stop that file instead of mixing versions.
- Preserve previous manual corrections and dubbing edits. A new run starts from
  automatic artifacts, never silently overlays manual edits. Same-run continuation
  consumes saved edits. Gate approvals bind to an exact artifact revision.
- Historical runs/results are viewable read-only. Unsaved drafts or active editing
  writes must be resolved before starting a conflicting run.
- New deliverables do not overwrite existing files: allocate incremented names;
  retries may atomically replace only paths owned by that run.

## Model and authority

Task: identity, draft with revision, current/history indexes.
TaskRun: immutable requested/effective configuration, input snapshots, lifecycle.
FileRun: per-file plan and stage records.
StageDefinition: version, dependencies, config/fingerprint, runner and validator.
StageRun: lifecycle, attempts, fingerprint, outcome, artifacts and diagnostics.
Artifact: type, digest, producer, integrity and automatic/manual provenance.

Run statuses: preparing, queued, running, pausing, paused, waiting_review,
cancelling, cancelled, succeeded, failed, interrupted. A task with no run is draft.
Queue exhaustion is not success. Required failures fail the file/run while usable
subtitles remain accessible. Optional degradation completes with visible warnings.
Restart interrupts in-flight work; paused/review states survive and paid work never
automatically resumes. One nonterminal run per task.

The main process owns transitions and capabilities. Legacy IFiles stage fields are
projections, not authority for new runs. Planned stage existence must never depend
on residual fields. All events carry run/file/stage/attempt/sequence ownership;
stale events are rejected before persistence and publication. Views consume a
versioned snapshot/patch, not arbitrary merges of worker file objects.

Commands carry requestId, projectId and expectedRunId where applicable; draft saves
use expectedDraftRevision. Replays return the original accepted run. Legacy IPC
and automation route through the same service. Generic saveWorkItem/saveTaskProject
cannot bypass active-run configuration/state protections.

## Effective configuration

Freeze result-affecting engine parameters and preset expansion, model identity,
provider model/endpoint/custom parameters/prompts/fallback order, glossary content,
language mappings, dubbing and composition preferences. Fingerprinting and runners
consume the same resolved configuration. Runtime credentials remain references to
the existing credential store; credential rotation alone does not invalidate output.
Validate installed models/credentials only for stages that need actual execution.

## Stages and reuse

Declare acquisition branches (import/pair/embedded/ASR including embedded fallback),
audio, ASR+diagnostics bundle, refine, manuscript, normalization, summary, translation,
speaker inference, speaker annotation, proofread data, export, manual gates, dubbing,
track construction and composition. Split speaker inference from subtitle annotation.
Keep ASR diagnostics bundled; no within-file parallel scheduler in this iteration.
Formatting/punctuation/layout belong to deliverables, not destructive upstream edits.

Fingerprint = SHA256(stage version + normalized effective configuration + input
digests + upstream artifact identities/producer fingerprints). Use the previous
run's valid automatic results/references; no search across unrelated historical
configurations or tasks. Changed/removed stages and dependency descendants become
invalid. Only committed, validated successes cross runs. Partial/degraded results
are not successful cross-run caches. Preserve existing same-run dubbing cue retry;
do not promise checkpointing within unfinished ASR. Missing delivery files trigger
only materialization when internal results are intact. Log stable cache reason codes.

## Durability and lifecycle

Run manifests and artifacts live under userData/task-runs, not system temp. Each
run has an independent manifest including acceptance receipts/configuration/stages;
WorkItem is a reconstructible index/projection. Acceptance and stage commits are
durable; ordinary progress may be throttled. Publish success only after writing,
validating and atomically committing artifacts. Readers never mutate upstream data;
copy writable stage inputs into independent attempt directories.

Retain raw ASR SRT, word timelines and diagnostics. Every transforming stage writes
a new version. Dubbing caches include automatic track/recovery data; new runs have
independent mutable sessions, materialized with copy-on-write filesystem copies
where possible and normal copies otherwise. Manual results remain separate.

No automatic eviction of referenced history/manual artifacts in v1. Clean only
uncommitted temporaries and proven unreferenced data. Deletion considers all runs,
proofreading and dubbing references; never delete user delivery files.

## Compatibility and verification

Lazily wrap legacy history without rewriting/moving original files. Label incomplete
historical configuration, never claim current defaults were its original settings.
Preserve supported legacy export/dubbing checkpoints behind an adapter; unverifiable
legacy SRTs are not new caches. New runs use the new model; unknown future schemas
are read-only/refused for writes.

Verify #564; global settings changes mid-run; all-file reevaluation; stage-boundary
pause with competing projects; cancel/restart/late callbacks; media replacement with
unchanged path/size/mtime; disabling stages/input routing; formatting-only reruns;
disk full/corruption/crash; partial translation/manual repairs; isolated history;
deletion with external references. Use controlled model/provider boundaries and
isolated Electron profiles, locally generated media and no paid cloud dependencies.
Run the pro baseline, summary, engines, automation regressions, new focused suites
and app build. Document native/platform coverage limitations.
