import React from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import DubbingSpeakerVoices from '../dubbing/DubbingSpeakerVoices';
jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function fixture() {
  return {
    speakers: [
      {
        id: 1,
        name: 'Host',
        cueCount: 2,
        totalDurationMs: 6000,
        color: '#00AA88',
      },
    ],
    cues: [
      {
        index: 0,
        text: 'Hello',
        speakerIds: [1],
        voiceId: 'override',
        needsUpdate: true,
      },
    ],
    speakerVoiceMap: { 1: '__global__' },
    speakerSettings: {},
    speakerVoiceConflicts: {},
    missingSpeakerVoiceIds: [],
    activeEngine: { voices: [{ id: 'a', label: 'A' }] },
    activeVoice: 'a',
    running: false,
    exporting: false,
    previewing: false,
    setSpeakerVoice: jest.fn(),
    setSpeakerSettings: jest.fn().mockResolvedValue(true),
    regenerateSpeaker: jest.fn(),
    previewVoice: jest.fn(),
    stopPreview: jest.fn(),
  };
}
it('commits validated role-local values and previews the same role', async () => {
  const dub = fixture();
  render(<DubbingSpeakerVoices dub={dub as any} />);
  const speed = screen.getByRole('spinbutton', { name: 'speakerSpeed' });
  fireEvent.change(speed, { target: { value: '1.25' } });
  fireEvent.blur(speed);
  await waitFor(() =>
    expect(dub.setSpeakerSettings).toHaveBeenCalledWith(1, {
      speed: 1.25,
      pitch: 0,
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'previewSpeakerVoice' }));
  expect(dub.previewVoice).toHaveBeenCalledWith('a', undefined, 1);
  fireEvent.click(screen.getByRole('button', { name: 'regenerateSpeaker' }));
  expect(dub.regenerateSpeaker).toHaveBeenCalledWith(1);
});
it('reverts invalid/failed edits and avoids duplicate commits while saving', async () => {
  const dub = fixture();
  let resolve!: (value: boolean) => void;
  dub.setSpeakerSettings.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<DubbingSpeakerVoices dub={dub as any} />);
  const pitch = screen.getByRole('spinbutton', { name: 'speakerPitch' });
  fireEvent.change(pitch, { target: { value: '13' } });
  fireEvent.blur(pitch);
  expect(pitch).toHaveValue(0);
  expect(dub.setSpeakerSettings).not.toHaveBeenCalled();
  fireEvent.change(pitch, { target: { value: '3' } });
  fireEvent.blur(pitch);
  fireEvent.blur(pitch);
  expect(dub.setSpeakerSettings).toHaveBeenCalledTimes(1);
  await act(async () => resolve(false));
  expect(pitch).toHaveValue(0);
});
it('disables edits during mutation and adopts restored settings', () => {
  const dub = fixture();
  const { rerender } = render(
    <DubbingSpeakerVoices dub={{ ...dub, speakerUpdating: true } as any} />,
  );
  expect(
    screen.getByRole('spinbutton', { name: 'speakerSpeed' }),
  ).toBeDisabled();
  rerender(
    <DubbingSpeakerVoices
      dub={{ ...dub, speakerSettings: { 1: { speed: 0.8, pitch: -2 } } } as any}
    />,
  );
  expect(screen.getByRole('spinbutton', { name: 'speakerSpeed' })).toHaveValue(
    0.8,
  );
  expect(screen.getByRole('spinbutton', { name: 'speakerPitch' })).toHaveValue(
    -2,
  );
});
it('requires an explicit choice when merged roles have different settings', () => {
  const dub = {
    ...fixture(),
    speakerSettingsConflicts: {
      1: [
        { speed: 1.25, pitch: 2 },
        { speed: 1, pitch: 0 },
      ],
    },
  };
  render(<DubbingSpeakerVoices dub={dub as any} />);
  expect(screen.getByRole('alert')).toHaveTextContent(
    'speakerSettingsConflict',
  );
  fireEvent.click(
    screen.getAllByRole('button', { name: 'speakerSettingsChoice' })[1],
  );
  expect(dub.setSpeakerSettings).toHaveBeenCalledWith(1, {
    speed: 1,
    pitch: 0,
  });
});
