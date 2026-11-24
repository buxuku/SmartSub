import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import SubtitleEditToolbar from '../subtitle/SubtitleEditToolbar';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// JSDOM does not provide the browser measurement API used by the real slider.
beforeEach(() => {
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, 'ResizeObserver');
});

const cue = (
  id: string,
  startTimeInSeconds: number,
  endTimeInSeconds: number,
) => ({
  id,
  startTimeInSeconds,
  endTimeInSeconds,
  startEndTime: '',
  content: ['First second'],
  sourceContent: 'First second',
});

function props(getSplitPlayheadTime?: () => number | undefined) {
  return {
    subtitles: [cue('1', 10, 30), cue('2', 30, 50)],
    onSubtitlesChange: jest.fn(),
    onUndo: jest.fn(),
    onRedo: jest.fn(),
    canUndo: false,
    canRedo: false,
    currentSubtitleIndex: 0,
    onMergeSubtitles: jest.fn(),
    onSplitSubtitle: jest.fn(),
    shouldShowTranslation: false,
    getCursorPosition: () => 5,
    getSplitPlayheadTime,
  };
}

function openSplit() {
  fireEvent.click(screen.getByRole('button', { name: 'split' }));
}

function confirmSplit() {
  fireEvent.click(screen.getByRole('button', { name: 'confirmSplit' }));
}

it('shows and confirms the exact playhead time near the cue start, without percentage rounding', () => {
  const toolbarProps = props(() => 10.123);
  render(<SubtitleEditToolbar {...toolbarProps} />);
  openSplit();
  expect(screen.getByText('0:10.123')).toBeInTheDocument();
  confirmSplit();
  expect(toolbarProps.onSplitSubtitle).toHaveBeenCalledWith(0, 5, 10.123);
});

it.each([undefined, 9, 10, 29.9999, 30, 31])(
  'defaults to the cue midpoint for an unavailable or out-of-range playhead (%s)',
  (time) => {
    const toolbarProps = props(() => time);
    render(<SubtitleEditToolbar {...toolbarProps} />);
    openSplit();
    confirmSplit();
    expect(toolbarProps.onSplitSubtitle).toHaveBeenCalledWith(0, 5, 20);
  },
);

it('keeps the initial cue and time when playback advances during a row-triggered split', () => {
  let playhead = 16.789;
  const toolbarProps = props(() => playhead);
  const onTriggerHandled = jest.fn();
  const { rerender } = render(
    <SubtitleEditToolbar
      {...toolbarProps}
      currentSubtitleIndex={1}
      splitRequest={{ index: 0, playheadTime: playhead }}
      onTriggerHandled={onTriggerHandled}
    />,
  );
  expect(onTriggerHandled).toHaveBeenCalled();

  playhead = 35;
  rerender(<SubtitleEditToolbar {...toolbarProps} currentSubtitleIndex={1} />);
  expect(screen.getByText('0:16.789')).toBeInTheDocument();
  confirmSplit();
  expect(toolbarProps.onSplitSubtitle).toHaveBeenCalledWith(0, 5, 16.789);
});

it('does not allow a split when the cue has no interior millisecond', () => {
  const toolbarProps = props(() => 10.0005);
  render(
    <SubtitleEditToolbar
      {...toolbarProps}
      subtitles={[cue('1', 10, 10.001)]}
    />,
  );
  openSplit();
  expect(screen.getByRole('button', { name: 'confirmSplit' })).toBeDisabled();
  confirmSplit();
  expect(toolbarProps.onSplitSubtitle).not.toHaveBeenCalled();
});

it('lets arrow keys adjust the split by approximately one percent of the cue', () => {
  const toolbarProps = props(() => 20);
  render(<SubtitleEditToolbar {...toolbarProps} />);
  openSplit();
  fireEvent.keyDown(screen.getByRole('slider', { name: 'timeSplitPosition' }), {
    key: 'ArrowRight',
  });
  confirmSplit();
  const [[, , splitTime]] = toolbarProps.onSplitSubtitle.mock.calls;
  expect(splitTime - 20).toBeCloseTo(0.2, 2);
});
