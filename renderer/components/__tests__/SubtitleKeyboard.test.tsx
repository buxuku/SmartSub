import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import SubtitleList from '../subtitle/SubtitleList';
import type { Subtitle } from '../../hooks/useSubtitles';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: any) => {
    const [start, setStart] = React.useState(0);
    return {
      getVirtualItems: () =>
        Array.from(
          { length: Math.min(2, options.count - start) },
          (_, offset) => ({
            index: start + offset,
            key: options.getItemKey(start + offset),
            start: offset * 34,
          }),
        ),
      getTotalSize: () => options.count * 34,
      measure: () => {},
      measureElement: () => {},
      scrollToIndex: (index: number) => setStart(index),
    };
  },
}));
const commit = jest.fn();
const clicked = jest.fn();
const initial: Subtitle[] = Array.from({ length: 5 }, (_, index) => ({
  id: String(index + 1),
  content: [`Original ${index}`],
  sourceContent: `Original ${index}`,
  targetContent: index === 0 || index === 3 ? '' : `Translation ${index}`,
  startTimeInSeconds: index * 2,
  endTimeInSeconds: index * 2 + 1,
  startEndTime: '00:00:00,000 --> 00:00:01,000',
}));
function Harness({ translated = true }: { translated?: boolean }) {
  const [current, setCurrent] = useState(0);
  const [subtitles, setSubtitles] = useState(initial);
  return (
    <SubtitleList
      mergedSubtitles={subtitles}
      currentSubtitleIndex={current}
      shouldShowTranslation={translated}
      handleSubtitleClick={(index) => {
        clicked(index);
        setCurrent(index);
      }}
      handleSubtitleChange={(index, field, value) =>
        setSubtitles((rows) =>
          rows.map((row, i) =>
            i === index ? { ...row, [field]: value } : row,
          ),
        )
      }
      onCommitRow={commit}
      expandAll={false}
      fontScale="m"
      isTranslationFailed={(row) => !row.targetContent}
      getFailedTranslationIndices={() =>
        subtitles.flatMap((row, index) => (row.targetContent ? [] : [index]))
      }
      goToNextFailedTranslation={() => {}}
      goToPreviousFailedTranslation={() => {}}
    />
  );
}
beforeEach(() => {
  Object.defineProperty(navigator, 'platform', {
    value: 'MacIntel',
    configurable: true,
  });
});

test('Tab stays in current row and Cmd+Enter preserves field across virtual rows', () => {
  render(<Harness />);
  const source = screen.getByRole('textbox', { name: 'originalSubtitle 1' });
  source.focus();
  fireEvent.keyDown(source, { key: 'Tab' });
  expect(
    screen.getByRole('textbox', { name: 'translatedSubtitle 1' }),
  ).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
  expect(source).toHaveFocus();
  fireEvent.keyDown(source, { key: 'Enter', metaKey: true });
  expect(
    screen.getByRole('textbox', { name: 'originalSubtitle 2' }),
  ).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
  fireEvent.keyDown(document.activeElement!, { key: 'Enter', metaKey: true });
  expect(
    screen.getByRole('textbox', { name: 'translatedSubtitle 3' }),
  ).toHaveFocus();
  expect(commit).toHaveBeenCalledTimes(2);
});

test('advances to the next visible failed row even after repairing the pinned row', async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('switch'));
  const target = screen.getByRole('textbox', { name: 'translatedSubtitle 1' });
  fireEvent.change(target, { target: { value: 'Repaired' } });
  target.focus();
  fireEvent.keyDown(target, { key: 'Enter', metaKey: true });
  expect(clicked).toHaveBeenLastCalledWith(3);
  const last = await screen.findByRole('textbox', {
    name: 'translatedSubtitle 4',
  });
  await waitFor(() => expect(last).toHaveFocus());
  fireEvent.keyDown(last, { key: 'Enter', metaKey: true });
  expect(last).toHaveFocus();
  expect(commit).toHaveBeenCalledTimes(2);
  expect(clicked).toHaveBeenCalledTimes(1);
});

test('IME, repeats and unrelated modifiers do not advance; plain Enter remains newline', () => {
  render(<Harness translated={false} />);
  const source = screen.getByRole('textbox', { name: 'originalSubtitle 1' });
  for (const event of [
    { key: 'Enter' },
    { key: 'Enter', ctrlKey: true },
    { key: 'Enter', metaKey: true, isComposing: true },
    { key: 'Enter', metaKey: true, repeat: true },
    { key: 'Enter', metaKey: true, shiftKey: true },
    { key: 'Enter', metaKey: true, altKey: true },
    { key: 'Tab', isComposing: true },
  ])
    expect(fireEvent.keyDown(source, event)).toBe(true);
  expect(commit).not.toHaveBeenCalled();
  fireEvent.keyDown(source, { key: 'Enter', metaKey: true });
  expect(
    screen.getByRole('textbox', { name: 'originalSubtitle 2' }),
  ).toHaveFocus();
});
