# Issue #579 verification

Implemented on `fix/task-run-storage-lifecycle`, based on v3.12.1 (`e3ff1cd2`).

## Behavior

- New run manifests, artifacts and editable revisions follow the unified storage root. Existing runs retain their recorded locations across root changes and restarts.
- Attempt workspaces use short paths under the effective temporary directory. Built-in transcription adapters read committed audio; word timelines and faster-whisper diagnostics use the attempt output directory.
- Durable metadata is rebound before artifact hashing/publication. Settlement removes unreferenced workspaces; recovery and explicit cleanup protect checkpoints, history, standalone proofreading, dubbing and drafts.
- Task deletion persists retirement before reclaiming unreferenced data. Unavailable roots, unknown schemas, corrupt metadata and symlinks prevent unsafe cleanup.
- Settings expose storage usage, cleanup, migration preview, scheduling and cancellation. Migration runs before editors open, verifies copies, rewrites owned path references and draft identities, refreshes artifact checksums and relocated input identities, then switches locations. Interrupted publication resumes from its journal; old-copy deletion failures retain the copies and retry on a later launch.

## Automated checks

| Check                                                     | Result                                                                                                                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test:task-runs`                                          | 55 passed, including migration interruption, ENOSPC, corrupt-copy, draft identity, deferred cleanup, paused-input identity and multi-root retirement cases |
| `test:stage-artifacts`                                    | 7 passed                                                                                                                                                   |
| `test:stage-cache`                                        | 5 passed                                                                                                                                                   |
| `test:storage-paths`                                      | 51 passed                                                                                                                                                  |
| `test:engines`                                            | 1,142 engine assertions; sherpa worker/runtime, 24 WAV I/O checks and Qwen scaffold passed                                                                 |
| `test:proofread-data`                                     | 37 passed                                                                                                                                                  |
| `test:audio-cache`                                        | 5 passed                                                                                                                                                   |
| `test:dubbing-ownership`, `test:work-item-durability`     | Passed                                                                                                                                                     |
| `typecheck`, `check:i18n`, production build               | Passed                                                                                                                                                     |
| Changed TypeScript/test formatting and `git diff --check` | Passed                                                                                                                                                     |

## Electron verification

`test:e2e:task-storage` generates real audio and uses a local HTTP ASR fixture, with an isolated Electron profile. It checks one retained WAV per newly transcribed task, no duplicate WAV in the transcription bundle, empty completed workspaces, word-timeline ownership, the migration dialog and scheduling button, restart migration, proofreading save after migration, safe deletion and preservation of the original media. Final evidence directory: `smartsub-task-storage-KBDIY1` in the local temporary directory; includes a settings screenshot.

`test:e2e:task-runs` passed lifecycle, history, presentation, review, delivery and stage-settings scenarios. Evidence directories include `smartsub-task-runs-e2e-CeKkXQ`, `smartsub-run-review-e2e-BiPUr6`, and `smartsub-run-delivery-msNb7I`.

The existing settings reliability script assumes a development main-process build and an HTTP renderer. Its initial run against a production build failed that URL assumption. A temporary, untracked copy changed only launch mode and URL selectors to use the production `app:` renderer; all nine persistence/failure/retry/navigation scenarios passed with no page errors. Evidence: `smartsub-settings-e2e-2p2BYY`. The temporary script and development server were removed.

## Platform coverage

Verification ran on macOS. Windows long-path behavior and writable flush handles are covered by the existing regression tests, but an actual Windows/NTFS machine and a real cross-volume migration were not available in this session. Those platform acceptance checks remain necessary before release. The migration copies files and verifies bytes instead of depending on cross-volume renames or filesystem block sharing.
