import {
  DEFAULT_TRANSLATE_CONTENT,
  TRANSLATE_CONTENT_VALUES,
  isTranslateContent,
  normalizeTranslateContent,
  withValidTranslateContent,
} from '../../../types/translateContent';
import { defaultUserConfig } from '../../../main/helpers/utils';
import { translateContentLabelKey } from '../translateContentLabel';

// utils.ts only touches `app` inside functions; importing it must not need Electron.
jest.mock('electron', () => ({ app: {} }));

describe('the shared output-style rules', () => {
  test('translation only is the default, as it was in 3.8', () => {
    expect(DEFAULT_TRANSLATE_CONTENT).toBe('onlyTranslate');
  });

  test('knows exactly the three styles the content templates support', () => {
    expect([...TRANSLATE_CONTENT_VALUES]).toEqual([
      'onlyTranslate',
      'sourceAndTranslate',
      'translateAndSource',
    ]);
  });

  test.each([...TRANSLATE_CONTENT_VALUES])('%s is kept as it is', (style) => {
    expect(isTranslateContent(style)).toBe(true);
    expect(normalizeTranslateContent(style)).toBe(style);
  });

  test.each([undefined, null, '', 'both', 'SourceAndTranslate', 0, {}, []])(
    '%p is not a style and falls back to the default',
    (value) => {
      expect(isTranslateContent(value)).toBe(false);
      expect(normalizeTranslateContent(value)).toBe(DEFAULT_TRANSLATE_CONTENT);
    },
  );

  test('new installs are seeded with the shared default', () => {
    expect(defaultUserConfig.translateContent).toBe(DEFAULT_TRANSLATE_CONTENT);
  });
});

describe('withValidTranslateContent', () => {
  test.each(['generateAndTranslate', 'translateOnly'])(
    'fills a missing style of a %s task',
    (taskType) => {
      expect(
        withValidTranslateContent({ taskType, targetLanguage: 'zh' }),
      ).toEqual({
        taskType,
        targetLanguage: 'zh',
        translateContent: 'onlyTranslate',
      });
    },
  );

  test('replaces an invalid style', () => {
    expect(
      withValidTranslateContent({
        taskType: 'translateOnly',
        translateContent: 'both',
      }).translateContent,
    ).toBe('onlyTranslate');
  });

  test.each([...TRANSLATE_CONTENT_VALUES])(
    'keeps a valid %s style and returns the very same object',
    (translateContent) => {
      const config = { taskType: 'generateAndTranslate', translateContent };
      expect(withValidTranslateContent(config)).toBe(config);
    },
  );

  test('never touches a task that does not translate', () => {
    const missing = { taskType: 'generateOnly' };
    expect(withValidTranslateContent(missing)).toBe(missing);
    expect(missing).not.toHaveProperty('translateContent');

    const invalid = { taskType: 'generateOnly', translateContent: 'both' };
    expect(withValidTranslateContent(invalid)).toBe(invalid);
    expect(invalid.translateContent).toBe('both');
  });

  test('does not mutate its input', () => {
    const config = { taskType: 'translateOnly' } as Record<string, unknown>;
    const fixed = withValidTranslateContent(config);
    expect(fixed).not.toBe(config);
    expect(config).not.toHaveProperty('translateContent');
  });
});

describe('translateContentLabelKey', () => {
  test.each([
    ['onlyTranslate', 'outputTranslationOnly'],
    ['translateAndSource', 'outputTranslationFirst'],
    ['sourceAndTranslate', 'outputSourceFirst'],
    [undefined, 'outputTranslationOnly'],
    ['both', 'outputTranslationOnly'],
  ])('labels %p as %s', (style, key) => {
    expect(translateContentLabelKey(style)).toBe(key);
  });
});
