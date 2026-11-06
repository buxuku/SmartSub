# Task runtime refactor implementation plan

> Implement inline with superpowers:executing-plans; use a fresh whole-branch reviewer after all phases. Track verified progress in the plan ledger.

**Goal:** Deliver immutable task runs, authoritative stage lifecycle, independent artifacts and safe task-local incremental reruns.

**Architecture:** Keep engine/resource adapters and file concurrency. Add a main-owned run service with pure shared planning/state types and a durable artifact store. Adapt existing entrypoints and project views to its projections.

**Tech stack:** TypeScript, Electron, React, Node filesystem/crypto, existing test tools. No added framework/database.

**Spec:** `docs/superpowers/specs/2026-10-24-task-runtime-design.md` (approved conversation captured verbatim in requirements/decisions).

## Global constraints

- Complete all six phases; retain user data and existing supported recovery paths.
- Pause at stage boundaries, freeing file slots; hash complete media on new runs.
- Previous manual edits survive but are not inherited by new runs.
- All accepted execution config is immutable; only main can change run state.
- All-file reevaluation on rerun; cache only proven automatic committed outputs.
- No cross-task cache, new database, standalone workflow rewrite or paid test calls.

## Review focus

- Paused/review work has no worker but is not complete (desktop and automation).
- Late worker callbacks and renderer autosaves cannot affect a newer run.
- Failure between artifact commit, manifest commit and projection publication.
- Same-path replaced inputs and mutable provider/glossary/model dependencies.
- History/manual/dubbing references must survive reruns and deletion/cleanup.

## Task 1: Shared stage definitions and legacy correctness

**Interfaces:** shared stage key registry, planned/legacy stage selection and normalization consumed by UI, migration and startup recovery.

- [x] Add failing behavioral regression tests for cancelled optional fields (#564), explicit disabled stages, summary recovery and mixed completed/pending files.
- [x] Implement a shared stage definition module, use it in stageUtils/workItemMigration/workItemStore, and explicitly reset cancelled stale fields.
- [x] Verify the new `test:task-runs` stage cases and existing pipeline, submission, durability, summary/stage/UI tests.
- [x] Commit the independently verified fix and update the ledger.

## Task 2: Immutable runs, snapshots and main-process authority

**Interfaces:** TaskRun/FileRun/StageRun/Artifact models; idempotent run commands, revisioned draft save, get/list state; owned event reducer; effective configuration snapshots.

- [x] Test durable acceptance/replay/conflict, frozen config, draft conflicts, stale events, restart states and renderer write protection.
- [x] Implement shared types, per-run manifest storage/recovery, the run service and configuration materialization with credential references.
- [x] Integrate task submission/context/store/IPC; keep old channels as adapters and enforce locks on alternate write paths.
- [x] Run `test:task-runs`, submission/durability/defaults/project and automation regression tests; commit and ledger.

## Task 3: Stage execution and pause/recovery

**Interfaces:** stage runner context/result/checkpoint, scheduling yield and owned attempts; centralized lifecycle/capability projection.

- [x] Test pause releasing slots, cancellation barriers, retry attempts, gate/review behavior, failure aggregation and automation waits.
- [x] Extract stage adapters from fileProcessor and implement boundary-yield dispatch using the existing queue/resource gates.
- [x] Route resume/retry/cancel/manual release/download handoffs/automation through the run service.
- [x] Verify focused lifecycle tests and existing pipeline/gates/download/activity/automation tests; commit and ledger.

## Task 4: Durable artifacts and independent edit/history versions

**Interfaces:** attempt workspace, commit/validate/materialize artifact bundles, input snapshots, run history and reference-aware ownership/deletion.

- [x] Add `test:stage-artifacts` for non-mutating upstream transforms, commit failures, corruption, output ownership, history/edit separation and references.
- [x] Persist immutable ASR/transform/translation/speaker/proofread/dubbing/composition artifacts; snapshot inputs and isolate mutable editor/session data.
- [x] Add history/read-only views, safe output allocation and referenced cleanup; bind manual approvals to saved artifacts.
- [x] Run artifact, proofreading, dubbing ownership/recovery and export suites; commit and ledger.

## Task 5: Fingerprints and all-file incremental reruns

**Interfaces:** stage-specific effective config, dependency lineage, streaming SHA-256, reuse decisions/reason codes, force policy.

- [x] Add `test:stage-cache` for changed config/input/upstream/implementation, disabling stages, missing output, same-metadata replacement, degraded results and force rerun.
- [x] Integrate fingerprint validation into every stage; reevaluate all files and preserve only eligible previous automatic artifacts.
- [x] Show input verification, executed/reused/skipped/degraded outcomes and cached source; check dependencies only for actual executions.
- [x] Verify controlled full pipelines with exact model/provider invocation counts; commit and ledger.

## Task 6: Compatibility, full UI integration and end-to-end acceptance

**Interfaces:** public task view/commands and legacy projections consumed by all launchers/lists/automation, isolated legacy recovery adapter.

- [x] Add `test:e2e:task-runs` with isolated user data and generated media for cancellation/retry/pause/history/locks/reuse.
- [x] Finish all entrypoint/UI integration, translations, history compatibility, version protection and user documentation.
- [x] Run new suites, `test:pro-baseline`, `test:summary`, `test:engines`, `test:automation:regressions`, related Electron tests and app build.
- [x] Dispatch independent whole-branch review; fix important findings with regression tests, document coverage limits, commit and ledger.

## Delivery

Leave the reviewed implementation on its isolated local branch/worktree. Do not push,
merge, publish or destroy user data as part of this task. Report verification and
any material unverified behavior accurately.

Verification and coverage: [task-runtime-verification](2026-10-24-task-runtime-verification.md).
