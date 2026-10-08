import {
  newTaskDefaults,
  toRememberedTaskDefaults,
} from '../../../types/taskConfig';
import { resolveDefaultTranslateProviderId } from '../providerPanelUtils';
import { buildLaunchpadDraft } from '../launchpadDraft';
import { BUILTIN_RECIPES } from '../recipes';

test('a new bilingual goal overrides the legacy output default without mutating preferences', () => {
  const preferences = {
    translateContent: 'onlyTranslate',
    targetLanguage: 'zh',
  };
  expect(
    newTaskDefaults(preferences, 'generateAndTranslate').translateContent,
  ).toBe('sourceAndTranslate');
  expect(preferences.translateContent).toBe('onlyTranslate');
  expect(newTaskDefaults(preferences, 'translateOnly').translateContent).toBe(
    'onlyTranslate',
  );
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

test('launchpad bilingual drops inherit the goal while custom recipes keep their output settings', () => {
  const recipe = BUILTIN_RECIPES.find(
    (item) => item.id === 'builtin-generate-translate',
  )!;
  expect(
    buildLaunchpadDraft([], { translateContent: 'onlyTranslate' }, recipe)
      .config?.translateContent,
  ).toBe('sourceAndTranslate');
  expect(
    buildLaunchpadDraft(
      [],
      {},
      {
        ...recipe,
        builtin: false,
        config: { translateContent: 'onlyTranslate' },
      },
    ).config?.translateContent,
  ).toBe('onlyTranslate');
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
