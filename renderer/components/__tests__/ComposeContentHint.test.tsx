import fs from 'fs';
import path from 'path';
import { render, screen } from '@testing-library/react';
import ComposeContentHint from '../tasks/wizard/ComposeContentHint';

// The mocked t() echoes the interpolated style label, so a test can see which
// output style the hint names without depending on the locale files.
jest.mock('next-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { content?: string }) =>
      options?.content === undefined ? key : `${key}|${options.content}`,
  }),
}));

describe('the final-video subtitle hint', () => {
  test.each([
    ['onlyTranslate', 'home:outputTranslationOnly'],
    ['sourceAndTranslate', 'home:outputSourceFirst'],
    ['translateAndSource', 'home:outputTranslationFirst'],
  ])(
    'names the %s output style when subtitles are burned in',
    (translateContent, label) => {
      render(
        <ComposeContentHint
          translateOn
          composeSubtitle="hard"
          translateContent={translateContent}
        />,
      );
      expect(
        screen.getByText(`wizard.composeContentHint|${label}`),
      ).toBeInTheDocument();
    },
  );

  test('also applies to soft subtitles, which carry the same file', () => {
    render(
      <ComposeContentHint
        translateOn
        composeSubtitle="soft"
        translateContent="sourceAndTranslate"
      />,
    );
    expect(
      screen.getByText('wizard.composeContentHint|home:outputSourceFirst'),
    ).toBeInTheDocument();
  });

  test('reads an unset style as the translation-only default the main process applies', () => {
    render(
      <ComposeContentHint
        translateOn
        composeSubtitle="hard"
        translateContent={undefined}
      />,
    );
    expect(
      screen.getByText('wizard.composeContentHint|home:outputTranslationOnly'),
    ).toBeInTheDocument();
  });

  test('says nothing when the video carries no subtitles', () => {
    const { container } = render(
      <ComposeContentHint
        translateOn
        composeSubtitle="none"
        translateContent="sourceAndTranslate"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  test('says nothing when nothing is translated, because the output style only shapes translated files', () => {
    const { container } = render(
      <ComposeContentHint
        translateOn={false}
        composeSubtitle="hard"
        translateContent="sourceAndTranslate"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('the hint in the shipped locales', () => {
  const readLocale = (locale: string, namespace: string) =>
    JSON.parse(
      fs.readFileSync(
        path.join(
          __dirname,
          '../../public/locales',
          locale,
          `${namespace}.json`,
        ),
        'utf8',
      ),
    );

  test.each(['zh', 'en'])(
    '%s interpolates the style name and every style label exists',
    (locale) => {
      expect(readLocale(locale, 'tasks').wizard.composeContentHint).toContain(
        '{{content}}',
      );
      const home = readLocale(locale, 'home');
      for (const key of [
        'outputTranslationOnly',
        'outputTranslationFirst',
        'outputSourceFirst',
      ]) {
        expect(typeof home[key]).toBe('string');
        expect(home[key]).not.toBe('');
      }
    },
  );
});
