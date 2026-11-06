import { act, renderHook } from '@testing-library/react';
import { useVideoPlayer } from '../useVideoPlayer';
import type { Subtitle } from '../useSubtitles';

const subtitles: Subtitle[] = [0, 1, 2].map((index) => ({
  id: String(index),
  content: [`Row ${index}`],
  startEndTime: '',
  startTimeInSeconds: index * 2,
  endTimeInSeconds: index * 2 + 1.8,
}));

test('playhead updates do not unmount the focused subtitle editor', () => {
  const selected = jest.fn();
  const { result } = renderHook(() => useVideoPlayer(subtitles, 0, selected));
  selected.mockClear();
  const editor = document.createElement('textarea');
  editor.dataset.subtitleEditor = 'source';
  document.body.append(editor);
  editor.focus();
  act(() => result.current.handleProgress({ playedSeconds: 2.5 }));
  expect(selected).not.toHaveBeenCalled();
  editor.remove();
  act(() => result.current.handleProgress({ playedSeconds: 2.6 }));
  expect(selected).toHaveBeenLastCalledWith(1);
});

test('row navigation updates time without a player and batched toggles are not stale', () => {
  const selected = jest.fn();
  const { result } = renderHook(() => useVideoPlayer(subtitles, 0, selected));
  act(() => result.current.handleSubtitleClick(2));
  expect(result.current.currentTime).toBe(4);
  expect(selected).toHaveBeenLastCalledWith(2);
  act(() => {
    result.current.togglePlay();
    result.current.togglePlay();
  });
  expect(result.current.isPlaying).toBe(false);
  act(() => result.current.setIsPlaying(true));
  act(() => result.current.togglePlay());
  expect(result.current.isPlaying).toBe(false);
});

test('overlapping cues retain the explicitly selected row until its time range ends', () => {
  const overlapping = [
    subtitles[0],
    { ...subtitles[0], id: 'overlap', endTimeInSeconds: 3 },
  ];
  const selected = jest.fn();
  const { result } = renderHook(() => useVideoPlayer(overlapping, 0, selected));
  act(() => result.current.handleSubtitleClick(0));
  selected.mockClear();
  act(() => result.current.handleProgress({ playedSeconds: 0.01 }));
  expect(selected).not.toHaveBeenCalled();
  act(() => result.current.handleProgress({ playedSeconds: 2 }));
  expect(selected).toHaveBeenLastCalledWith(1);
});

test('seeking short cues stays inside their duration', () => {
  const selected = jest.fn();
  const { result } = renderHook(() =>
    useVideoPlayer(
      [{ ...subtitles[0], startTimeInSeconds: 0.1, endTimeInSeconds: 0.101 }],
      0,
      selected,
    ),
  );
  const seekTo = jest.fn();
  Object.assign(result.current.playerRef, { current: { seekTo } });
  act(() => result.current.handleSubtitleClick(0));
  expect(seekTo).toHaveBeenCalledWith(0.1005, 'seconds');
});
