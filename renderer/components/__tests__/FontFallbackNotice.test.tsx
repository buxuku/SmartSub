import React from 'react';
import { render, screen } from '@testing-library/react';
import FontFallbackNotice from '../subtitleMerge/FontFallbackNotice';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

it('renders nothing when no fallback or missing glyph was reported', () => {
  const { container } = render(
    <FontFallbackNotice report={{ fallbacks: [], missingGlyphs: [] }} />,
  );
  expect(container).toBeEmptyDOMElement();
});

it('names the fallback font and the covered sample', () => {
  render(
    <FontFallbackNotice
      report={{
        fallbacks: [
          { from: 'Helvetica', to: 'Apple SD Gothic Neo', sample: '지금' },
        ],
        missingGlyphs: [],
      }}
    />,
  );
  expect(screen.getByRole('status')).toHaveTextContent('Apple SD Gothic Neo');
  expect(screen.getByRole('status')).toHaveTextContent('지금');
  expect(
    screen.getByRole('status').querySelector('[data-font-missing-glyphs]'),
  ).toBeNull();
});

it('lists missing characters and truncates long lists', () => {
  const chars = Array.from({ length: 15 }, (_, index) =>
    String.fromCodePoint(0x1200 + index),
  );
  render(
    <FontFallbackNotice report={{ fallbacks: [], missingGlyphs: chars }} />,
  );
  const message = screen
    .getByRole('status')
    .querySelector('[data-font-missing-glyphs]')!;
  expect(message).toHaveTextContent(chars[0]);
  expect(message).toHaveTextContent('+3');
  expect(message).not.toHaveTextContent(chars[14]);
});
