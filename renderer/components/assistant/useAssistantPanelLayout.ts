import { useEffect, useRef, useState } from 'react';

export function useAssistantPanelLayout(open: boolean, close: () => void) {
  const panel = useRef<HTMLElement>(null);
  const resizing = useRef(false);
  const cleanup = useRef<() => void>();
  const [width, setWidth] = useState(440);
  const [maximum, setMaximum] = useState(800);
  const clamp = (value: number) =>
    Math.max(
      Math.min(360, window.innerWidth - 64),
      Math.min(
        value,
        Math.min(
          880,
          window.innerWidth - (window.innerWidth >= 1440 ? 480 : 64),
        ),
      ),
    );
  useEffect(() => {
    const saved = Number(localStorage.getItem('assistant:width'));
    if (saved > 0) setWidth(clamp(saved));
    const resize = () => {
      setMaximum(clamp(Infinity));
      setWidth((value) => clamp(value));
    };
    resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      cleanup.current?.();
    };
  }, []);
  useEffect(() => {
    if (!open) {
      cleanup.current?.();
      return;
    }
    // Close after the target click completes, so reflow cannot swallow an
    // outside button's click when the docked panel disappears.
    const outside = (event: MouseEvent) => {
      if (resizing.current || !(event.target instanceof Element)) return;
      if (
        !panel.current?.contains(event.target) &&
        !event.target.closest('[data-assistant-toggle]')
      )
        close();
    };
    document.addEventListener('click', outside);
    return () => document.removeEventListener('click', outside);
  }, [open, close]);
  const updateWidth = (value: number) => {
    const next = clamp(value);
    setWidth(next);
    localStorage.setItem('assistant:width', String(next));
  };
  const startResize = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizing.current = true;
    const right = panel.current!.getBoundingClientRect().right;
    const oldCursor = document.body.style.cursor;
    const oldSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (event: PointerEvent) => updateWidth(right - event.clientX);
    const finish = () => {
      resizing.current = false;
      document.body.style.cursor = oldCursor;
      document.body.style.userSelect = oldSelect;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
      cleanup.current = undefined;
    };
    cleanup.current = finish;
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
  };
  return { panel, width, maximum, updateWidth, startResize };
}
