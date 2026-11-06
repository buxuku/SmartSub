import {
  ROW_TONE_BAR,
  ROW_TONE_BORDER,
  getRowTone,
  type RowTone,
} from '../tasks/rowTone';

describe('getRowTone', () => {
  it.each<[string, boolean, boolean, RowTone]>([
    // A failed stage always wins, whatever the display state says.
    ['error', false, false, 'error'],
    ['idle', true, false, 'error'],
    ['gate', true, true, 'error'],
    // States that wait for the user, and any warning, ask for attention.
    ['gate', false, false, 'attention'],
    ['cancelling', false, false, 'attention'],
    ['interrupted', false, false, 'attention'],
    ['running', false, true, 'attention'],
    ['done', false, true, 'attention'],
    ['running', false, false, 'running'],
    ['done', false, false, 'done'],
    // Everything else is calm.
    ['idle', false, false, 'idle'],
    ['queued', false, false, 'idle'],
    ['paused', false, false, 'idle'],
    ['cancelled', false, false, 'idle'],
  ])(
    'maps %s (failed=%s, warning=%s) to %s',
    (state, failed, warning, tone) => {
      expect(getRowTone(state, failed, warning)).toBe(tone);
    },
  );

  it('defines an outline and a bar colour for every tone', () => {
    const tones: RowTone[] = ['idle', 'running', 'attention', 'error', 'done'];
    for (const tone of tones) {
      expect(ROW_TONE_BORDER[tone]).toMatch(/^border-/);
      expect(ROW_TONE_BAR[tone]).toMatch(/^bg-/);
    }
    // Neutral tones keep the strong outline; the others tint it.
    expect(ROW_TONE_BORDER.idle).toBe('border-border-strong');
    expect(ROW_TONE_BORDER.done).toBe('border-border-strong');
  });
});
