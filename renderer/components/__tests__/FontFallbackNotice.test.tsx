import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import FontFallbackNotice from '../subtitleMerge/FontFallbackNotice';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

let invoke: jest.Mock;
beforeEach(() => {
  invoke = jest.fn().mockResolvedValue({
    success: true,
    data: { fonts: [], complete: true },
  });
  window.ipc = { invoke } as any;
});
const props = {
  fontName: 'Helvetica',
  subtitlePath: '/a.srt',
  sampleText: 'sample',
  onSelectFont: jest.fn(),
};

it('renders nothing when no fallback or missing glyph was reported', () => {
  const { container } = render(
    <FontFallbackNotice
      {...props}
      report={{ fallbacks: [], missingGlyphs: [] }}
    />,
  );
  expect(container).toBeEmptyDOMElement();
  expect(invoke).not.toHaveBeenCalled();
});

it('names the fallback font and the covered sample', async () => {
  render(
    <FontFallbackNotice
      {...props}
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
  await act(async () => {});
});

it('lists missing characters and truncates long lists', async () => {
  const chars = Array.from({ length: 15 }, (_, index) =>
    String.fromCodePoint(0x1200 + index),
  );
  render(
    <FontFallbackNotice
      {...props}
      report={{ fallbacks: [], missingGlyphs: chars }}
    />,
  );
  const message = screen
    .getByRole('status')
    .querySelector('[data-font-missing-glyphs]')!;
  expect(message).toHaveTextContent(chars[0]);
  expect(message).toHaveTextContent('+3');
  expect(message).not.toHaveTextContent(chars[14]);
  await act(async () => {});
});

const missingReport = { fallbacks: [], missingGlyphs: ['\u{10FFFF}'] };

it('recommends installed fonts that cover the whole subtitle and switches on click', async () => {
  invoke.mockResolvedValue({
    success: true,
    data: {
      fonts: [
        { name: 'Apple SD Gothic Neo', displayName: '산돌고딕' },
        { name: 'Arial Unicode MS' },
      ],
      complete: true,
    },
  });
  const onSelectFont = jest.fn();
  render(
    <FontFallbackNotice
      {...props}
      onSelectFont={onSelectFont}
      report={missingReport}
    />,
  );
  expect(screen.getByText('fontRecommendLoading')).toBeVisible();
  const button = await screen.findByRole('button', { name: /산돌고딕/ });
  expect(invoke).toHaveBeenCalledWith('subtitleMerge:recommendFonts', {
    subtitlePath: '/a.srt',
    sampleText: 'sample',
    fontName: 'Helvetica',
  });
  expect(screen.queryByText('fontRecommendLoading')).toBeNull();
  fireEvent.click(button);
  expect(onSelectFont).toHaveBeenCalledWith('Apple SD Gothic Neo');
  fireEvent.click(screen.getByRole('button', { name: 'Arial Unicode MS' }));
  expect(onSelectFont).toHaveBeenLastCalledWith('Arial Unicode MS');
});

it('keeps the warning and shows no buttons when recommendations are empty or fail', async () => {
  const { unmount } = render(
    <FontFallbackNotice {...props} report={missingReport} />,
  );
  await act(async () => {});
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByText('fontRecommendLoading')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('fontMissingGlyphs');
  expect(screen.getByText('fontInstallHint')).toBeVisible();
  unmount();
  invoke.mockRejectedValue(new Error('ipc down'));
  render(<FontFallbackNotice {...props} report={missingReport} />);
  await act(async () => {});
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('fontMissingGlyphs');
});

it('ignores a late recommendation after the report changed', async () => {
  let resolveFirst!: (value: unknown) => void;
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );
  const { rerender } = render(
    <FontFallbackNotice {...props} report={missingReport} />,
  );
  rerender(
    <FontFallbackNotice
      {...props}
      fontName="Other"
      report={{ fallbacks: [], missingGlyphs: ['\u{10FFFE}'] }}
    />,
  );
  await act(async () =>
    resolveFirst({
      success: true,
      data: { fonts: [{ name: 'Stale font' }], complete: true },
    }),
  );
  expect(screen.queryByRole('button', { name: 'Stale font' })).toBeNull();
});

it('disables the buttons when the style cannot be edited', async () => {
  invoke.mockResolvedValue({
    success: true,
    data: { fonts: [{ name: 'Arial Unicode MS' }], complete: true },
  });
  render(
    <FontFallbackNotice
      {...props}
      onSelectFont={undefined}
      report={missingReport}
    />,
  );
  expect(
    await screen.findByRole('button', { name: 'Arial Unicode MS' }),
  ).toBeDisabled();
});
