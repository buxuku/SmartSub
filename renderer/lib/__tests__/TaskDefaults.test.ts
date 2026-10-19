import {
  newTaskDefaults,
  toRememberedTaskDefaults,
} from '../../../types/taskConfig';
import { TRANSLATE_CONTENT_VALUES } from '../../../types/translateContent';
import { resolveDefaultTranslateProviderId } from '../providerPanelUtils';
import { buildLaunchpadDraft } from '../launchpadDraft';
import { BUILTIN_RECIPES } from '../recipes';

describe('seeding a new task from the saved preferences', () => {
  test.each([...TRANSLATE_CONTENT_VALUES])(
    'the saved %s output style wins for every task type',
    (translateContent) => {
      const preferences = { translateContent, targetLanguage: 'zh' };
      for (const taskType of [
        'generateAndTranslate',
        'translateOnly',
        'generateOnly',
      ])
        expect(newTaskDefaults(preferences, taskType)).toEqual({
          ...preferences,
          taskType,
        });
    },
  );

  test('a task type never invents an output style the user did not save', () => {
    expect(
      newTaskDefaults({ targetLanguage: 'zh' }, 'generateAndTranslate'),
    ).not.toHaveProperty('translateContent');
  });

  test('leaves the saved preferences untouched', () => {
    const preferences = {
      translateContent: 'onlyTranslate',
      targetLanguage: 'zh',
    };
    const before = structuredClone(preferences);
    newTaskDefaults(preferences, 'generateAndTranslate');
    expect(preferences).toEqual(before);
  });
});

test('browsing a service cannot influence fallback task selection', () => {
  localStorage.setItem(
    'resourcesProvidersSelectedId',
    JSON.stringify('googleFree'),
  );
  const providers = [
    { id: 'googleFree', type: 'googleFree', name: 'Google' },
    { id: 'autoFree', type: 'autoFree', name: 'Automatic free' },
  ] as any;
  expect(resolveDefaultTranslateProviderId(providers)).toBe('autoFree');
  expect(resolveDefaultTranslateProviderId(providers, 'googleFree')).toBe(
    'googleFree',
  );
});

describe('launchpad drops', () => {
  const bilingualCard = BUILTIN_RECIPES.find(
    (item) => item.id === 'builtin-generate-translate',
  )!;

  test.each([...TRANSLATE_CONTENT_VALUES])(
    'the built-in translation card keeps the saved %s output style',
    (translateContent) => {
      expect(
        buildLaunchpadDraft([], { translateContent }, bilingualCard).config
          ?.translateContent,
      ).toBe(translateContent);
    },
  );

  test('no built-in recipe pins an output style, so a card stays an alias of the task page', () => {
    expect(
      BUILTIN_RECIPES.filter(
        (recipe) => recipe.config?.translateContent !== undefined,
      ).map((recipe) => recipe.id),
    ).toEqual([]);
  });

  test('a custom recipe keeps the output style it was saved with', () => {
    expect(
      buildLaunchpadDraft(
        [],
        { translateContent: 'onlyTranslate' },
        {
          ...bilingualCard,
          builtin: false,
          config: { translateContent: 'translateAndSource' },
        },
      ).config?.translateContent,
    ).toBe('translateAndSource');
  });
});

describe('remembering a started task as the next default', () => {
  // Advanced settings a user picked on the task page: exactly what 3.9 forgot.
  const started = {
    sourceLanguage: 'ja',
    targetLanguage: 'zh',
    translateProvider: 'deepseek',
    translateContent: 'sourceAndTranslate',
    transcriptionEngine: 'builtin',
    model: 'large-v3',
    maxContext: 6,
    batchSize: 12,
    useEmbeddedSubtitles: false,
    speakerDiarization: true,
    speakerDiarizationCount: 3,
    subtitleOutputFormats: ['srt', 'vtt'],
    customParameters: { temperature: 0.2, nested: { flag: true } },
  };
  // Inputs of one single task, never a preference.
  const perTask = {
    taskType: 'generateAndTranslate',
    manuscriptPath: '/tmp/script.txt',
    manuscriptName: 'script.txt',
    dub: { engine: 'edge' },
    compose: { burn: true },
    gates: { subtitle: 'manual' },
    cloudUploadConsent: true,
  };

  test('keeps every setting the user picked', () => {
    expect(toRememberedTaskDefaults({ ...started, ...perTask })).toEqual(
      started,
    );
  });

  test.each(Object.keys(perTask))(
    '%s belongs to a single task and is never remembered',
    (key) => {
      expect(
        toRememberedTaskDefaults({
          ...started,
          [key]: (perTask as Record<string, unknown>)[key],
        }),
      ).not.toHaveProperty(key);
    },
  );

  test('uses no allow-list, so a setting added later is remembered too', () => {
    expect(
      toRememberedTaskDefaults({ ...started, brandNewAdvancedSetting: 42 }),
    ).toMatchObject({ brandNewAdvancedSetting: 42 });
  });

  test('leaves the task being started untouched', () => {
    const input = { ...started, ...perTask };
    const before = structuredClone(input);
    toRememberedTaskDefaults(input);
    expect(input).toEqual(before);
  });

  test.each([
    ['nothing', undefined],
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
    ['an empty object', {}],
    ['only per-task inputs', perTask],
  ])(
    'refuses %s so a bad call can never wipe the defaults',
    (_label, payload) => {
      expect(() => toRememberedTaskDefaults(payload)).toThrow(
        'INVALID_TASK_DEFAULTS',
      );
    },
  );
});
