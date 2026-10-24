# Unified task stage settings implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Let recipe tasks edit every existing stage in the same task page.

**Architecture:** Share controlled dubbing, composition and checkpoint editors
between TaskWizard and the task page. Group the task page by its current draft's
stages; keep last-result configuration and the durable runtime unchanged.

**Tech Stack:** React, TypeScript, Radix UI, Electron, Jest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-25-task-stage-settings-design.md`

## Global constraints

- Existing isolated branch/worktree; no new dependencies or runtime schema.
- Edit existing stages only; no implicit source-recipe/global preference writes.
- Active run fields disabled, section navigation enabled; terminal drafts editable.
- Preserve unknown nested fields and explicit unavailable choices.
- Do not replace the user's active development build for acceptance tests.

## Review focus

- Missing engine/voice/style retains the saved selection rather than auto-switching.
- A style snapshot survives unrelated edits and a deleted/modified style preset.
- Locked popovers and checkpoint controls cannot modify accepted configuration.
- New wizard defaults and restored drafts do not race metadata loading.
- A changed pipeline draft submits all files while previous results retain their semantics.

### Task 1: Shared pipeline configuration editors

Files: create `renderer/components/tasks/settings/PipelineSettings.tsx`,
`renderer/hooks/useComposeOptions.ts`, `renderer/lib/pipelineSettings.ts`;
modify `renderer/components/tasks/wizard/TaskWizard.tsx`; add focused Jest tests.

Interfaces: controlled DubbingSettings, ComposeSettings and ReviewSettings take
existing typed configs, onChange and disabled; metadata remains separate from
draft values. Helpers construct initial dubbing/compose settings and preserve
saved style payloads. The wizard uses these same controls and payload helpers.

- [x] Add failing tests for edits preserving unrelated nested values, explicit
      unavailable resources, disabled controls and compose style snapshots.
- [x] Extract common controls, resource loading and payload construction; wire
      the wizard without changing goals, input pairing, draft or recipe behavior.
- [x] Pass focused tests and type checks; commit this independently usable extraction.

### Task 2: Task-page groups and complete task identity

Files: create `renderer/components/tasks/TaskConfigSections.tsx`; modify
`renderer/pages/[locale]/tasks/[type].tsx`, zh/en task translations; tests.

Interfaces: TaskConfigSections receives form, formData, disabled and existing
subtitle toolbar children. It updates dub/compose/gates through the same form.

- [x] Add failing tests for conditional groups, keyboard-accessible section
      navigation while locked, preserved edits and compact subtitle-only layout.
- [x] Use recipe/pipeline title and flow summary for pipeline tasks, expose
      shared editors and keep the existing draft/save/start lifecycle.
- [x] Pass focused tests; commit page integration.

### Task 3: Production acceptance and documentation

Files: extend `scripts/e2e/task-runs-review.mjs` or add a pipeline-settings
scenario to `scripts/e2e/task-runs.mjs`; update `docs/task-runs.md`.

- [x] Exercise full pipeline and custom-recipe task identity; edit voice/speed,
      composition and checkpoints; reload; verify immutable previous configuration.
- [x] Check locked navigation/controls, next-run payload, stage reuse and narrow
      layout in isolated production Electron; keep screenshots as evidence.
- [x] Run task runtime, appropriate renderer tests, pro baseline, typecheck and
      production build. Get a fresh whole-change review and fix blocking findings.
- [x] Document verification, commit and preserve the local branch/worktree.

## Verification

- Shared editors/configuration helpers/section navigation and related settings tests:
  55 passed. Activity and list layout regressions: 38 passed.
- Task runtime: 33 passed, including cancellation at a manual checkpoint.
- All 44 pro-baseline commands passed; task draft recovery was checked again after
  the compose-default fixes. Renderer/main/automation/crash type checks passed.
- Production renderer/main/CLI/MCP build passed in a separate filesystem copy.
- Four Electron scenarios passed: task lifecycle, translation presentation,
  manual review/dubbing approval, and the new recipe stage-settings workflow.
- New desktop acceptance creates a custom recipe through the wizard, changes
  voice/speed, checks locked groups, cancels, edits composition/checkpoints,
  restores after reload, reprocesses, and checks compose-only reuse. It asserts
  the source recipe and previous run configuration are unchanged. Screenshots
  and overflow checks cover 1024, 1440 and 1920 px.
- The independent reviewer found two composition-default issues. Both were fixed
  by resolving only missing preference fields, with RED/GREEN regressions for
  new/cleared drafts, partial recipes and late preferences. No blocking findings
  remain. Production acceptance also caught and fixed missing translation
  namespaces after reload, and stale review actions on cancelled tasks.

The extraction and its task-page integration are committed together after the
combined acceptance flow. Logs and local screenshot locations are recorded in
`.superpowers/sdd/2026-10-25-task-stage-settings/`. No paid TTS/translation services
were used; fixtures use generated media, a local HTTP TTS server and real FFmpeg.
