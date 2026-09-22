import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import SpeechGapContext from '../proofread/SpeechGapContext';
import { qualityIssueContext } from '../../lib/qualityIssueContext';
import type { QualityIssue } from '../../../types/qualityReview';
import type { Subtitle } from '../../hooks/useSubtitles';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const issue: QualityIssue = {
  key: 'gap',
  kind: 'speech',
  start: 5,
  end: 7,
  indices: [],
  more: false,
  priority: 1,
  evidence: 'gap',
  detail: { reason: 'speech' },
};
const cue = (id: string, start: number, end: number): Subtitle => ({
  id,
  startTimeInSeconds: start,
  endTimeInSeconds: end,
  startEndTime: '',
  sourceContent: `Original ${id}`,
  targetContent: `译文 ${id}`,
  content: [`Original ${id}`],
});
const rows = [
  cue('one', 1, 2),
  cue('two', 3, 5),
  cue('three', 7, 8),
  cue('four', 10, 12),
];

test('shows the nearest bilingual neighbors around the gap and listens through both complete cues', () => {
  const onListen = jest.fn();
  render(
    <SpeechGapContext
      issue={issue}
      rows={rows}
      translation
      onListen={onListen}
    />,
  );
  expect(screen.getByText('Original two')).toBeVisible();
  expect(screen.getByText('Original three')).toBeVisible();
  expect(screen.getByText('译文 two')).toBeVisible();
  expect(screen.queryByText('Original one')).not.toBeInTheDocument();
  expect(screen.getByText('00:00:05.000 – 00:00:07.000')).toBeVisible();
  fireEvent.click(
    screen.getByRole('button', { name: 'quality.gapContext.listen' }),
  );
  expect(onListen).toHaveBeenLastCalledWith({ ...issue, start: 3, end: 8 });
  fireEvent.click(
    screen.getByRole('button', { name: 'quality.gapContext.more' }),
  );
  expect(screen.getByText('Original one')).toBeVisible();
  expect(screen.getByText('Original four')).toBeVisible();
  fireEvent.click(
    screen.getByRole('button', { name: 'quality.gapContext.listen' }),
  );
  expect(onListen).toHaveBeenLastCalledWith({ ...issue, start: 1, end: 12 });
  fireEvent.click(
    screen.getByRole('button', { name: 'quality.gapContext.less' }),
  );
  expect(screen.queryByText('Original one')).not.toBeInTheDocument();
});

test('picks neighbors by time rather than cue ID or file order, excluding invalid and overlapping cues', () => {
  const unordered = [
    rows[3],
    rows[0],
    cue('overlap', 4, 8),
    rows[2],
    cue('invalid', NaN, 5),
    rows[1],
  ];
  expect(qualityIssueContext(issue, unordered)).toEqual({
    before: [5, 1],
    after: [3, 0],
  });
  expect(qualityIssueContext({ start: 0, end: 1 }, rows)).toEqual({
    before: [],
    after: [0, 1],
  });
  expect(qualityIssueContext({ start: 12, end: 15 }, rows)).toEqual({
    before: [3, 2],
    after: [],
  });
});

test('explains missing context at document boundaries and works without media or translation', () => {
  const { rerender } = render(
    <SpeechGapContext
      issue={{ ...issue, start: 0, end: 1 }}
      rows={rows}
      translation={false}
    />,
  );
  expect(screen.getByText('quality.gapContext.noBefore')).toBeVisible();
  expect(screen.getByText('Original one')).toBeVisible();
  expect(screen.queryByText('译文 one')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'quality.gapContext.listen' }),
  ).not.toBeInTheDocument();
  rerender(
    <SpeechGapContext
      issue={{ ...issue, start: 12, end: 15 }}
      rows={rows}
      translation={false}
    />,
  );
  expect(screen.getByText('quality.gapContext.noAfter')).toBeVisible();
  rerender(<SpeechGapContext issue={issue} rows={[]} translation={false} />);
  const context = screen.getByRole('region', {
    name: 'quality.gapContext.title',
  });
  expect(
    within(context).getByText('quality.gapContext.noBefore'),
  ).toBeVisible();
  expect(within(context).getByText('quality.gapContext.noAfter')).toBeVisible();
});
