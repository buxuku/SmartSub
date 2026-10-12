/**
 * How loudly an entry of the task list announces its state: a tinted outline
 * and bar colour on top of the text, so a run of entries can be scanned
 * without reading each status line (colour is never the only signal).
 */
export type RowTone = 'idle' | 'running' | 'attention' | 'error' | 'done';

/**
 * A failed stage always wins. Anything that waits for the user (a gate, a
 * cancellation in progress, an interrupted run) or carries a warning asks for
 * attention; running and finished entries get their own tint; the rest is calm.
 */
export function getRowTone(
  state: string,
  failed: boolean,
  warning: boolean,
): RowTone {
  if (failed || state === 'error') return 'error';
  if (
    warning ||
    state === 'gate' ||
    state === 'cancelling' ||
    state === 'interrupted'
  )
    return 'attention';
  if (state === 'running') return 'running';
  if (state === 'done') return 'done';
  return 'idle';
}

/** Neutral tones keep the strong outline so every entry has a visible edge. */
export const ROW_TONE_BORDER: Record<RowTone, string> = {
  idle: 'border-border-strong',
  running: 'border-primary/50',
  attention: 'border-warning/50',
  error: 'border-destructive/50',
  done: 'border-border-strong',
};

export const ROW_TONE_BAR: Record<RowTone, string> = {
  idle: 'bg-primary',
  running: 'bg-primary',
  attention: 'bg-warning',
  error: 'bg-destructive',
  done: 'bg-success',
};
