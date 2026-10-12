import { useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import {
  restoreRemovedFile,
  useUndoableFileRemoval,
} from '../useUndoableFileRemoval';

interface Item {
  uuid: string;
}
const item = (uuid: string): Item => ({ uuid });
const ids = (list: Item[]) => list.map((entry) => entry.uuid).join(',');

/** The task page in miniature: a file list, the open project and the undo toasts. */
function setup(initial: string[], locked = false) {
  const projectIdRef = { current: 'project-1' as string | null };
  const toasts: { file: Item; undo: () => void }[] = [];
  const onRemoved = (file: Item, undo: () => void) => {
    toasts.push({ file, undo });
  };
  const view = renderHook(
    (props: { locked: boolean }) => {
      const [files, setFiles] = useState(initial.map(item));
      const remove = useUndoableFileRemoval({
        files,
        setFiles,
        locked: props.locked,
        projectIdRef,
        onRemoved,
      });
      return { files, remove };
    },
    { initialProps: { locked } },
  );
  return {
    projectIdRef,
    toasts,
    list: () => ids(view.result.current.files),
    remove: (uuid: string) => act(() => view.result.current.remove(uuid)),
    undo: (index = toasts.length - 1) => act(() => toasts[index].undo()),
    setLocked: (next: boolean) => view.rerender({ locked: next }),
  };
}

test('removes the file at once and offers exactly one undo', () => {
  const page = setup(['a', 'b', 'c']);
  page.remove('b');
  expect(page.list()).toBe('a,c');
  expect(page.toasts.map((toast) => toast.file.uuid)).toEqual(['b']);
});

test('undo puts the file back where it was', () => {
  const page = setup(['a', 'b', 'c']);
  for (const uuid of ['a', 'c', 'b']) {
    page.remove(uuid);
    page.undo();
    expect(page.list()).toBe('a,b,c');
  }
});

test('undo goes to the end when the list got shorter in the meantime', () => {
  const page = setup(['a', 'b', 'c']);
  page.remove('c');
  page.remove('a');
  page.remove('b');
  page.undo(0);
  expect(page.list()).toBe('c');
});

test('undoing twice does not duplicate the file', () => {
  const page = setup(['a', 'b']);
  page.remove('a');
  page.undo();
  page.undo();
  expect(page.list()).toBe('a,b');
});

test('undo is dropped once another project is open', () => {
  const page = setup(['a', 'b', 'c']);
  page.remove('b');
  page.projectIdRef.current = 'project-2';
  page.undo();
  expect(page.list()).toBe('a,c');
});

test('an unknown file is ignored and offers no undo', () => {
  const page = setup(['a']);
  page.remove('missing');
  expect(page.list()).toBe('a');
  expect(page.toasts).toHaveLength(0);
});

test('refuses to remove a file while the queue is busy', () => {
  const page = setup(['a', 'b', 'c'], true);
  page.remove('b');
  expect(page.list()).toBe('a,b,c');
  expect(page.toasts).toHaveLength(0);
});

test('removes again once the queue is idle', () => {
  const page = setup(['a', 'b', 'c'], true);
  page.setLocked(false);
  page.remove('b');
  expect(page.list()).toBe('a,c');
  expect(page.toasts).toHaveLength(1);
});

describe('restoreRemovedFile', () => {
  const list = [item('a'), item('b'), item('c')];

  test.each([
    [0, 'x,a,b,c'],
    [2, 'a,b,x,c'],
    [3, 'a,b,c,x'],
    [99, 'a,b,c,x'],
  ])('inserts at index %i', (index, expected) => {
    expect(ids(restoreRemovedFile(list, item('x'), index))).toBe(expected);
  });

  test('returns the same list when the file is already there', () => {
    expect(restoreRemovedFile(list, item('b'), 0)).toBe(list);
  });

  test('does not change the list it was given', () => {
    restoreRemovedFile(list, item('x'), 1);
    expect(ids(list)).toBe('a,b,c');
  });
});
