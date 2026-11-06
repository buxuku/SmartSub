# CUDA Recommendation and Status Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement these regression fixes.

**Goal:** Fix the incorrect CUDA lite recommendation and stale fallback display identified in issue #130.

**Architecture:** Share a pure Toolkit compatibility predicate across main and renderer. Keep active backend session-local while retaining persisted diagnostic history, and send null on invalidation.

**Tech Stack:** Electron, TypeScript, React, tsx, Jest.

**Spec:** `docs/superpowers/specs/2026-10-28-cuda-recommendation-status-design.md`

## Global Constraints

- No new dependencies; preserve driver-based addon version selection.
- Same Toolkit major, equal/newer minor; unknown versions default to full.
- Preserve diagnostic history; current state must reflect actual session loads.
- Work on `fix/cuda-recommendation-and-status` as requested.

## Review Focus

- Manual CUDA version changes must recompute package compatibility.
- A new Toolkit major cannot supply an older addon's differently named libraries.
- nvcc component patch versions are not Toolkit release patch versions.
- Invalidation must update both the settings card and global status listeners.
- Restarting or replacing a package must not erase historical evidence.

### Task 1: Recommendation and download UI

- [x] Add failing cases to CUDA wiring tests and renderer download-sheet tests.
- [x] Add shared compatibility predicate and use it in main/UI recommendations, manual selections, and download defaults.
- [x] Update localized descriptions; run the targeted regressions.

### Task 2: Session status and verification

- [x] Add failing loader tests for persisted history, invalidation notification, and reload.
- [x] Return only current-session state; notify null on invalidation and keep diagnostic history.
- [x] Update pending/current-session labels and nullable renderer event typing.
- [x] Run GPU suite, renderer tests, locale/format checks and TypeScript checks; review diff.

## Execution evidence

Pre-flight: tasks share only the GPU card and locale files; recommendation and session-state semantics are independent. Prior investigation established the two root causes; no further user clarification is needed for this authorized fix.

- RED: CUDA wiring reproduced five incorrect lite recommendations; loader tests reproduced two stale-state cases; renderer tests reproduced four edition-selection/validation failures.
- GREEN: `npm run test:gpu-enumeration` — 57 passed; `npx jest --runInBand` — 101 suites / 1100 tests passed, including five download-sheet regressions.
- Both `npx tsc --noEmit --incremental false -p main/tsconfig.json` and the renderer equivalent passed.
- Locale parity, Prettier checks, and `git diff --check` passed.
- Existing download-sheet Radix missing-description warnings remain visible in test output; they do not fail the tests and are outside this fix.
- Independent read-only review found no actionable regressions.
- Review scope decisions: native CUDA loading still requires the user's Windows reproduction; GPU-mode setting changes retain their existing cache-key behavior and are outside the restart/reinstall bugs. The cost is that neither behavior is newly verified by this fix.
- Work remains on the requested local branch; no merge or publication was performed.
