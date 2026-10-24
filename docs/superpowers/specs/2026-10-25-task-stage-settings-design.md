# Unified task stage settings

The user selected the recommended third approach: one task page whose settings
follow the actual processing stages, including dubbing and video composition.

## Intent and scope

- A task from a built-in or custom recipe must expose every existing stage's
  configuration after processing. First scope: edit existing stages; adding or
  removing dubbing/composition stages is deferred.
- Show the recipe name or actual pipeline title and a compact flow summary.
  Subtitle task-type tabs remain available for ordinary subtitle tasks; pipeline
  tasks use their full identity rather than those three partial modes.
- Pipeline tasks have parameter groups for subtitles/translation, dubbing,
  composition and review checkpoints, only where applicable. Show a compact
  summary in each group and one expanded editor at a time. Ordinary tasks retain
  their compact toolbar.
- Section navigation stays usable during processing, pauses and manual review.
  Editable fields follow the existing run lock; terminal tasks unlock
  automatically and save to the current task draft. Reprocessing submits all
  files with the edited configuration and existing stage reuse semantics.
- Existing results and the source recipe are unchanged by parameter edits.
  Workbenches remain for detailed editing of an individual result. No implicit
  recipe overwrite or new recipe-management flow is added.

## Approaches

Adding settings only under More settings leaves the task identity misleading.
Returning to the creation wizard interrupts iteration and suggests a new task.
The selected approach shares stage editors between the wizard and task page.

## Implementation boundaries

Keep the existing taskType/dub/compose/gates representation and runtime. Extract
controlled stage fields, compose resource loading and payload helpers from the
wizard. Existing explicit values must not be silently replaced when an engine,
voice or style is unavailable. Preserve nested options and resolved style
snapshots when editing unrelated fields. Defaults apply only to new choices.
Keep source-only/subtitle input cases, automatic TTS language, custom styles,
hardware availability and checkpoint options consistent between both surfaces.

Validation covers draft persistence, lock transitions, unavailable selections,
style preservation, the wizard and reprocessing. Production Electron verification
uses a separate filesystem copy while the user's development watcher is active.
