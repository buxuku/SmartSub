import { newTaskDefaults } from '../../../types/taskConfig';
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
