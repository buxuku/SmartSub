import {
  applyTaskDefaultsPatch,
  isTaskDefaultsKey,
  newTaskDefaults,
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

describe('patching the saved defaults with what the user changed', () => {
  // Preferences saved by earlier edits on the task page.
  const stored = {
    sourceLanguage: 'en',
    targetLanguage: 'zh',
    translateProvider: 'autoFree',
    translateContent: 'onlyTranslate',
    maxContext: 3,
    subtitleOutputFormats: ['srt'],
    customParameters: { temperature: 0.2, nested: { flag: true } },
  };

  test('changes only the keys the user touched', () => {
    expect(
      applyTaskDefaultsPatch(stored, {
        maxContext: 6,
        translateProvider: 'deepseek',
      }),
    ).toEqual({ ...stored, maxContext: 6, translateProvider: 'deepseek' });
  });

  test('replaces a nested setting as a whole instead of merging it', () => {
    expect(
      applyTaskDefaultsPatch(stored, { customParameters: { top_p: 0.9 } })
        .customParameters,
    ).toStrictEqual({ top_p: 0.9 });
  });

  test('an undefined value removes the key so the factory default applies again', () => {
    const { maxContext: _removed, ...rest } = stored;
    expect(
      applyTaskDefaultsPatch(stored, { maxContext: undefined }),
    ).toStrictEqual(rest);
  });

  test.each(Object.keys(perTask))(
    '%s belongs to a single task and never reaches the defaults',
    (key) => {
      const next = applyTaskDefaultsPatch(stored, {
        maxContext: 6,
        [key]: (perTask as Record<string, unknown>)[key],
      });
      expect(next).not.toHaveProperty(key);
      expect(next).toEqual({ ...stored, maxContext: 6 });
    },
  );

  test('a patch carrying only per-task inputs changes nothing', () => {
    expect(applyTaskDefaultsPatch(stored, perTask)).toEqual(stored);
  });

  test('manuscripts already sitting in the stored config are dropped on the next write', () => {
    expect(
      applyTaskDefaultsPatch(
        { ...stored, manuscriptPath: '/old.txt', manuscriptName: 'old.txt' },
        { maxContext: 6 },
      ),
    ).toEqual({ ...stored, maxContext: 6 });
  });

  test('uses no allow-list, so a setting added later is remembered too', () => {
    expect(
      applyTaskDefaultsPatch(stored, { brandNewAdvancedSetting: 42 }),
    ).toMatchObject({ brandNewAdvancedSetting: 42 });
  });

  test('leaves the stored config and the patch untouched', () => {
    const base = structuredClone({ ...stored, manuscriptPath: '/old.txt' });
    const baseBefore = structuredClone(base);
    // Built from literals each time: the expectation must not share references with
    // the patch the function receives.
    const makePatch = () => ({
      maxContext: undefined,
      targetLanguage: 'ja',
      customParameters: { top_p: 0.9 },
      taskType: 'generateOnly',
      dub: { engine: 'edge' },
      manuscriptPath: '/tmp/script.txt',
    });
    const patch = makePatch();
    applyTaskDefaultsPatch(base, patch);
    expect(base).toStrictEqual(baseBefore);
    expect(patch).toStrictEqual(makePatch());
  });

  test.each([
    ['nothing', undefined],
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
    ['a number', 5],
  ])(
    'refuses %s so a bad call can never rewrite the defaults',
    (_label, payload) => {
      expect(() => applyTaskDefaultsPatch(stored, payload)).toThrow(
        'INVALID_TASK_DEFAULTS',
      );
    },
  );

  test.each([undefined, null, [], 'garbage', 7])(
    'rebuilds an unusable stored config (%j) from the patch alone',
    (unusable) => {
      expect(
        applyTaskDefaultsPatch(unusable, { maxContext: 6, ...perTask }),
      ).toEqual({ maxContext: 6 });
    },
  );

  test('cannot replace the prototype of the stored config', () => {
    const patch = JSON.parse(
      '{"__proto__": {"polluted": true}, "maxContext": 6}',
    );
    const next = applyTaskDefaultsPatch(stored, patch);
    expect(next.maxContext).toBe(6);
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
    expect(next.polluted).toBeUndefined();
  });
});

describe('which keys count as reusable preferences', () => {
  test.each(Object.keys(perTask))('%s is not a preference', (key) => {
    expect(isTaskDefaultsKey(key)).toBe(false);
  });

  test.each(['sourceLanguage', 'maxContext', 'brandNewAdvancedSetting'])(
    '%s is a preference',
    (key) => {
      expect(isTaskDefaultsKey(key)).toBe(true);
    },
  );
});
