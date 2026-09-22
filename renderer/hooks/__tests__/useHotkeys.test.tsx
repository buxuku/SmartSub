import React from 'react';
import { fireEvent, render, renderHook } from '@testing-library/react';
import { isEditableTarget, useHotkeys } from '../useHotkeys';

beforeEach(() => {
  Object.defineProperty(navigator, 'platform', {
    value: 'MacIntel',
    configurable: true,
  });
});

test('matches exact platform modifiers, ignores IME and repeats, and cleans up', () => {
  const handler = jest.fn();
  const { unmount } = renderHook(() =>
    useHotkeys([{ combo: 'mod+s', handler }]),
  );
  for (const modifiers of [
    { ctrlKey: true },
    { metaKey: true, ctrlKey: true },
    { metaKey: true, altKey: true },
    { metaKey: true, shiftKey: true },
    { metaKey: true, repeat: true },
    { metaKey: true, isComposing: true },
  ]) {
    expect(fireEvent.keyDown(document.body, { key: 's', ...modifiers })).toBe(
      true,
    );
  }
  expect(handler).not.toHaveBeenCalled();
  expect(fireEvent.keyDown(document.body, { key: 'S', metaKey: true })).toBe(
    false,
  );
  expect(handler).toHaveBeenCalledTimes(1);
  unmount();
  fireEvent.keyDown(document.body, { key: 's', metaKey: true });
  expect(handler).toHaveBeenCalledTimes(1);
});

test('uses Ctrl on non-Mac platforms and the latest binding', () => {
  Object.defineProperty(navigator, 'platform', { value: 'Win32' });
  const first = jest.fn();
  const second = jest.fn();
  const { rerender } = renderHook(
    ({ handler }) => useHotkeys([{ combo: 'mod+enter', handler }]),
    { initialProps: { handler: first } },
  );
  fireEvent.keyDown(document.body, { key: 'Enter', metaKey: true });
  expect(first).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, { key: 'Enter', ctrlKey: true });
  rerender({ handler: second });
  fireEvent.keyDown(document.body, { key: 'Enter', ctrlKey: true });
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
});

test('preserves native input, control activation and navigation', () => {
  const handler = jest.fn();
  const { container } = render(
    <div>
      <input />
      <textarea />
      <select />
      <button>
        <span>Play</span>
      </button>
      <a href="#">Link</a>
      <div role="slider" tabIndex={0} />
      <div contentEditable suppressContentEditableWarning>
        <span>Editable</span>
      </div>
    </div>,
  );
  renderHook(() => useHotkeys([{ combo: 'space', handler }]));
  for (const element of Array.from(
    container.querySelectorAll(
      'input, textarea, select, button span, a, [role="slider"], [contenteditable] span',
    ),
  )) {
    expect(fireEvent.keyDown(element, { key: ' ' })).toBe(true);
  }
  expect(
    isEditableTarget(container.querySelector('[contenteditable] span')),
  ).toBe(true);
  expect(handler).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, { key: ' ' });
  expect(handler).toHaveBeenCalledTimes(1);
});

test.each(['dialog', 'alertdialog', 'menu', 'listbox'])(
  'blocks background shortcuts behind %s, permits explicit overlay bindings',
  (role) => {
    const background = jest.fn();
    const overlay = jest.fn();
    const { container, unmount } = render(
      <div role={role}>
        <input />
      </div>,
    );
    renderHook(() =>
      useHotkeys([
        { combo: 'mod+s', allowInInput: true, handler: background },
        {
          combo: 'escape',
          allowInInput: true,
          allowInOverlay: true,
          handler: overlay,
        },
      ]),
    );
    fireEvent.keyDown(container.querySelector('input')!, {
      key: 's',
      metaKey: true,
    });
    fireEvent.keyDown(container.querySelector('input')!, { key: 'Escape' });
    expect(background).not.toHaveBeenCalled();
    expect(overlay).toHaveBeenCalledTimes(1);
    unmount();
    fireEvent.keyDown(document.body, { key: 's', metaKey: true });
    expect(background).toHaveBeenCalledTimes(1);
  },
);

test('closed overlays do not block and predicates preserve native undo in other fields', () => {
  const handler = jest.fn();
  const { container } = render(
    <div>
      <div role="dialog" data-state="closed" />
      <input />
      <textarea data-subtitle-editor="source" />
    </div>,
  );
  renderHook(() =>
    useHotkeys([
      {
        combo: 'mod+z',
        allowInInput: true,
        handler,
        when: (e) =>
          !!(e.target as HTMLElement).closest('[data-subtitle-editor]'),
      },
    ]),
  );
  expect(
    fireEvent.keyDown(container.querySelector('input')!, {
      key: 'z',
      metaKey: true,
    }),
  ).toBe(true);
  expect(handler).not.toHaveBeenCalled();
  expect(
    fireEvent.keyDown(container.querySelector('textarea')!, {
      key: 'z',
      metaKey: true,
    }),
  ).toBe(false);
  expect(handler).toHaveBeenCalledTimes(1);
});

test('repeat opt-in and defaultPrevented are respected', () => {
  const handler = jest.fn();
  renderHook(() =>
    useHotkeys([{ combo: 'arrowdown', allowRepeat: true, handler }]),
  );
  fireEvent.keyDown(document.body, { key: 'ArrowDown', repeat: true });
  const event = new KeyboardEvent('keydown', {
    key: 'ArrowDown',
    bubbles: true,
    cancelable: true,
  });
  event.preventDefault();
  document.body.dispatchEvent(event);
  expect(handler).toHaveBeenCalledTimes(1);
});

test('modified commands remain available on focused buttons', () => {
  const handler = jest.fn();
  const { getByRole } = render(<button>Undo</button>);
  renderHook(() => useHotkeys([{ combo: 'mod+z', handler }]));
  fireEvent.keyDown(getByRole('button'), { key: 'z', metaKey: true });
  expect(handler).toHaveBeenCalledTimes(1);
});
