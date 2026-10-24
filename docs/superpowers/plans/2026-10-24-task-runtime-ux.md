# Task page UX follow-up

The user's screenshots and requested interaction supersede the previous visible
run-history / explicit next-draft editing flow. Keep run authority and immutable
results internally, while making the task page a repeatable edit-and-process loop.

- Keep the same configuration controls and task-type tabs visible. Disable them
  during queued/running/paused/review/cancelling work; automatically enable them
  after a terminal result. Changes are saved as the next configuration without
  changing the last result's stage plan or artifacts. Reopening restores the
  draft only when it belongs to the current run.
- Remove the run-history management panel from the task page. Show a short
  ordinary-language hint and “Process again” after a completed attempt.
- Give filenames their own row with actions/progress; place compact, wrapping
  stage chips below. Replace repeated outcome words with icons and accessible
  tooltips. Translate the incomplete-translation message without duplicating it.
- Verify draft restoration and immutable submitted configuration, lock/unlock
  transitions, rerunning with changed parameters, long names at narrow/wide
  window sizes, and the existing manual-review/translation acceptance flows.

Implementation stays in the existing isolated branch. No backend history deletion
or change to stage-reuse policy is included.

## Completed verification

- Task runtime tests: 32 passed; focused renderer tests: 52 passed.
- Pro baseline: all 44 commands passed, including task draft, project persistence,
  submission, navigation and input validation regressions.
- Renderer, main, automation and crash-script type checks passed.
- Production renderer/main/CLI/MCP build and all three task-run Electron
  scenarios passed in a separate filesystem copy with isolated user profiles.
  This avoided the user's active development watcher replacing the main bundle.
- Electron acceptance checked the long filename and compact stage rail at 1024,
  1440 and 1920 pixels; automatic edit/lock/unlock; changed-parameter submission;
  draft restoration; task-mode switching and reopening; and preserving the old
  bilingual proofreading result when the next mode is source-only.
- Translation reuse, proofreading saves, manual subtitle release and dubbing
  confirmation still passed against local HTTP fixtures. No paid calls were made.
- Independent code review found no remaining blocking issues after the draft
  loading/retry lock, mode restoration and result/draft separation fixes.

The regression for retry during draft loading failed on an enabled button before
the fix, then passed after readiness was enforced on the button and command.
The existing launchpad callback harness was extended with the new loading state
and now checks that both a loading draft and a failed draft load block retry.

Logs are retained locally under
`.superpowers/sdd/2026-10-24-task-runtime-refactor/ux-*.log`.
