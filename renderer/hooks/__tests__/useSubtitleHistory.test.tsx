import { act, renderHook } from '@testing-library/react';
import { useSubtitleHistory } from '../useSubtitleHistory';
import type { Subtitle } from '../useSubtitles';

const row = (id: number, text = `Original ${id}`): Subtitle => ({
  id: String(id),
  startEndTime: '00:00:00,000 --> 00:00:01,000',
  content: [text],
  sourceContent: text,
  startTimeInSeconds: 0,
  endTimeInSeconds: 1,
});

test('keeps all 1000 commands, replays exactly and drops only the redo branch', () => {
  const { result } = renderHook(useSubtitleHistory);
  let current = [row(0)];
  act(() => {
    for (let i = 0; i < 1000; i++) {
      const next = [row(0, `Edit ${i}`)];
      result.current.push({ start: 0, removed: current, inserted: next });
      current = next;
    }
  });
  act(() => {
    for (let i = 999; i >= 0; i--) {
      const previous = result.current.undo(current, []);
      expect(previous).not.toBeNull();
      current = previous!.subtitles;
      expect(current[0].sourceContent).toBe(i ? `Edit ${i - 1}` : 'Original 0');
    }
  });
  expect(result.current.canUndo).toBe(false);
  expect(result.current.canRedo).toBe(true);
  act(() => {
    for (let i = 0; i < 1000; i++) {
      current = result.current.redo(current, [])!.subtitles;
      expect(current[0].sourceContent).toBe(`Edit ${i}`);
    }
    current = result.current.undo(current, [])!.subtitles;
    result.current.push({
      start: 0,
      removed: current,
      inserted: [row(0, 'New branch')],
    });
  });
  expect(result.current.canRedo).toBe(false);
  act(() => result.current.reset());
  expect(result.current.canUndo).toBe(false);
});

test('undoes and redoes cue structure plus speaker metadata atomically', () => {
  const { result } = renderHook(useSubtitleHistory);
  const before = [row(0), row(1)];
  const after = [row(0, 'Merged')];
  const speakersBefore = [{ id: 0, displayName: 'First', color: '#abcdef' }];
  const speakersAfter = [{ id: 1, displayName: 'Second', color: '#fedcba' }];
  act(() =>
    result.current.pushDocument(before, after, speakersBefore, speakersAfter),
  );
  act(() =>
    expect(result.current.undo(after, speakersAfter)).toEqual({
      subtitles: before,
      speakers: speakersBefore,
    }),
  );
  act(() =>
    expect(result.current.redo(before, speakersBefore)).toEqual({
      subtitles: after,
      speakers: speakersAfter,
    }),
  );
});

test('bulk undo is not limited by the JavaScript argument stack', () => {
  const { result } = renderHook(useSubtitleHistory);
  const before = Array.from({ length: 150000 }, (_, index) => row(index));
  const after = [row(0, 'Merged')];
  act(() =>
    result.current.push({ start: 0, removed: before, inserted: after }),
  );
  act(() => expect(result.current.undo(after, [])?.subtitles).toEqual(before));
  act(() => expect(result.current.redo(before, [])?.subtitles).toEqual(after));
});
