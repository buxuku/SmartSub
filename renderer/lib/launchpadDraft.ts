import { v4 as uuidv4 } from 'uuid';
import type { TaskRecipe } from '../../types/recipe';
import { omitTaskManuscript } from '../../types/taskConfig';
import { recipeToWizardPrefill } from './recipes';
import type { TaskDraft } from './taskDraftManager';

export function buildLaunchpadDraft(
  files: TaskDraft['files'],
  defaults: Record<string, any>,
  recipe?: TaskRecipe,
): TaskDraft {
  const prefill = recipe ? recipeToWizardPrefill(recipe) : null;
  const config = { ...omitTaskManuscript(defaults), ...prefill?.config };
  const { dub, compose } = config;
  return {
    id: uuidv4(),
    files: structuredClone(files),
    config,
    goals: prefill?.goals ?? { translate: false, dub: false, video: false },
    manualPairs: [],
    manualManuscriptPairs: [],
    pipeline: {
      dubbing: dub
        ? {
            engineKey:
              dub.engine.kind === 'local'
                ? `local:${dub.engine.modelId}`
                : `cloud:${dub.engine.providerId}`,
            voice: dub.voice,
            language: dub.language || 'auto',
            globalSpeed: dub.globalSpeed || 1,
            cloneQuality: dub.cloneQuality ?? 'standard',
            localConcurrency: dub.localConcurrency ?? 1,
          }
        : {
            engineKey: '',
            voice: '',
            globalSpeed: 1,
            cloneQuality: 'standard',
            localConcurrency: 1,
          },
      subtitle: compose?.subtitle ?? 'hard',
      styleId: compose?.styleId ?? 'classic',
      quality: compose?.videoQuality ?? 'original',
      encoder: compose?.encoderMode ?? 'cpu',
      subtitleGate: prefill?.subtitleGateOn ?? true,
      dubbingGate: prefill?.dubbingGateOn ?? false,
      recipeName: recipe?.name?.trim() || null,
    },
    savedAt: Date.now(),
  };
}

export function appendLaunchpadFiles(
  draft: TaskDraft,
  files: TaskDraft['files'],
): TaskDraft {
  const merged = new Map(draft.files.map((file) => [file.filePath, file]));
  for (const file of files) {
    if (!merged.has(file.filePath)) merged.set(file.filePath, file);
  }
  return structuredClone({
    ...draft,
    id: draft.id || uuidv4(),
    files: Array.from(merged.values()),
    savedAt: Date.now(),
  });
}
