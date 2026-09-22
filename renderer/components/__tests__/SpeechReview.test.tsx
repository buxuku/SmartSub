import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { SpeechReviewBadge } from '../tasks/SpeechReviewBadge';
import MissedSpeechControls, {
  missedSpeechDescription,
} from '../subtitle/MissedSpeechControls';
import type { IFiles } from '../../../types';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

it('opens the actual changes and locates a backup, with a visible failure on error', async () => {
  const invoke = jest.fn().mockResolvedValue({ success: false });
  Object.defineProperty(window, 'ipc', {
    configurable: true,
    value: { invoke },
  });
  render(
    <SpeechReviewBadge
      file={
        {
          speechReviewSummary: {
            status: 'complete',
            recovered: 1,
            changes: [
              { start: 2, end: 3, original: '', text: 'Recovered sentence.' },
            ],
          },
          speechReviewOriginalFile: '/tmp/original.srt',
        } as IFiles
      }
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'row.speechRecovered' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('Recovered sentence.');
  expect(screen.getByRole('dialog')).toHaveTextContent('00:00:02.000');
  fireEvent.click(
    screen.getByRole('button', { name: 'speechReview.original' }),
  );
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith('speechReview.openFailed'),
  );
  expect(invoke).toHaveBeenCalledWith('subtitleMerge:openOutputFolder', {
    filePath: '/tmp/original.srt',
  });
});

it('shows review failure without claiming no omissions', () => {
  render(
    <SpeechReviewBadge
      file={{ speechReviewSummary: { status: 'unavailable' } } as IFiles}
    />,
  );
  expect(screen.getByText('speechReview.unavailable')).toHaveAttribute(
    'title',
    'speechReview.unavailableDetail',
  );
  expect(screen.queryByRole('button')).toBeNull();
});

it('describes timing-only corrections without claiming text was recovered', () => {
  render(
    <SpeechReviewBadge
      file={
        { speechReviewSummary: { status: 'complete', retimed: 1 } } as IFiles
      }
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'speechReview.retimed' }));
  expect(screen.getByRole('dialog')).toHaveTextContent(
    'speechReview.timingDescription',
  );
  expect(screen.getByRole('dialog')).not.toHaveTextContent(
    'speechReview.description',
  );
});

it('copies the selected suggestion, seeks it, and safely handles removal', async () => {
  const writeText = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  const onSeek = jest.fn();
  const warnings = [
    {
      id: 'w',
      startMs: 2000,
      endMs: 2300,
      level: 'high' as const,
      signals: ['speechReview' as const],
      cueIds: [],
      suggestedText: 'Yes.',
    },
  ];
  const { rerender } = render(
    <MissedSpeechControls warnings={warnings} onSeek={onSeek} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'missedSpeech.copy' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('Yes.'));
  fireEvent.click(screen.getByRole('button', { name: 'missedSpeech.listen' }));
  expect(onSeek).toHaveBeenCalledWith(2000);
  rerender(<MissedSpeechControls warnings={[]} onSeek={onSeek} />);
  expect(screen.queryByTestId('missed-speech-controls')).toBeNull();
});

it('reports clipboard failure and keeps the suggestion selectable', async () => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: jest.fn().mockRejectedValue(new Error('denied')) },
  });
  render(
    <MissedSpeechControls
      warnings={[
        {
          id: 'w',
          startMs: 0,
          endMs: 500,
          level: 'high',
          signals: ['speechReview'],
          cueIds: [],
          suggestedText: 'Quiet phrase.',
        },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'missedSpeech.copy' }));
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith('missedSpeech.copyFailed'),
  );
  expect(screen.getByTestId('missed-speech-controls')).toHaveTextContent(
    'Quiet phrase.',
  );
});

it('shows text differences with original and candidate, and labels timing issues', () => {
  const timing = {
    id: 'timing',
    startMs: 2000,
    endMs: 2300,
    level: 'high' as const,
    signals: ['speechReview' as const, 'timingMismatch' as const],
    cueIds: [],
    suggestedText: 'Great.',
  };
  expect(missedSpeechDescription(timing, (key) => key)).toContain(
    'missedSpeech.signal.timingMismatch',
  );
  const onSeek = jest.fn();
  render(
    <MissedSpeechControls
      onSeek={onSeek}
      warnings={[
        timing,
        {
          id: 'text',
          startMs: 5000,
          endMs: 5300,
          level: 'high',
          signals: ['speechReview', 'textMismatch'],
          cueIds: [],
          originalText: 'around',
          suggestedText: 'near',
        },
      ]}
    />,
  );
  expect(screen.getByTestId('missed-speech-controls')).toHaveTextContent(
    'missedSpeech.reviewCount',
  );
  fireEvent.click(screen.getByRole('button', { name: 'missedSpeech.next' }));
  expect(onSeek).toHaveBeenCalledWith(5000);
  expect(screen.getByTestId('missed-speech-controls')).toHaveTextContent(
    'around',
  );
  expect(screen.getByTestId('missed-speech-controls')).toHaveTextContent(
    'near',
  );
  expect(screen.getByTestId('missed-speech-controls')).toHaveTextContent(
    'missedSpeech.signal.textMismatch',
  );
});
