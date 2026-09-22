import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import VoiceLibrary, { filterLibraryVoices } from '../dubbing/VoiceLibrary';
import {
  normalizeTtsVoiceMetadata,
  parseTtsVoiceMetadata,
} from '../../../types/ttsVoice';
import { loadTtsEngineOptions } from '../../hooks/useTtsEngineOptions';
jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 84,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: index * 84,
      })),
  }),
}));
const voices = [
  {
    id: 'a',
    label: 'A',
    gender: 'female' as const,
    lang: 'en-US',
    styles: ['news'],
  },
  {
    id: 'b',
    label: 'B',
    gender: 'child' as const,
    lang: 'zh-CN',
    styles: ['anime'],
  },
  { id: 'c', label: 'C' },
];
beforeEach(() => {
  HTMLElement.prototype.scrollTo = jest.fn();
});
it('filters declared metadata without guessing unknown attributes', () => {
  expect(filterLibraryVoices(voices, '', 'female', 'en', 'news')).toEqual([
    voices[0],
  ]);
  expect(filterLibraryVoices(voices, '', 'child', 'zh', 'anime')).toEqual([
    voices[1],
  ]);
  expect(
    filterLibraryVoices(voices, 'c', 'unknown', 'unknown', 'unknown'),
  ).toEqual([voices[2]]);
  expect(
    normalizeTtsVoiceMetadata({
      gender: 'female-looking',
      lang: {},
      styles: ['newscast', {}, 'storytelling'],
    }),
  ).toEqual({ styles: ['news', 'story'] });
  expect(parseTtsVoiceMetadata('invalid')).toEqual({});
});
it('loads local/cloud metadata and deduplicates configured voices', async () => {
  window.ipc = {
    invoke: jest.fn(async (channel) =>
      channel === 'getTtsModelStatus'
        ? {
            engineInstalled: true,
            models: [
              {
                id: 'local',
                installed: true,
                voices: [{ id: '0', label: 'Zero', gender: 'm', lang: 'zh' }],
              },
            ],
          }
        : channel === 'getTtsProviders'
          ? [
              {
                id: 'p',
                name: 'P',
                type: 'edge',
                voices: 'a,a,b',
                voiceMetadata: {
                  a: { gender: 'child', lang: 'en', styles: ['anime'] },
                },
              },
            ]
          : { success: true, data: [] },
    ),
  } as any;
  const options = await loadTtsEngineOptions();
  expect(options[0].voices[0].gender).toBe('male');
  expect(options[1].voices).toHaveLength(2);
  expect(options[1].voices[0].gender).toBe('child');
  expect(options[1].voices[1].gender).toBeUndefined();
});
it('previews hovered options, cancels on exit, and keeps failed selections open', async () => {
  jest.useFakeTimers();
  const dub = {
    activeEngine: { key: 'cloud:p', voices },
    previewVoice: jest.fn(),
    stopPreview: jest.fn(),
  };
  const select = jest.fn().mockResolvedValue(false);
  render(
    <VoiceLibrary dub={dub as any} value="a" label="Voice" onSelect={select} />,
  );
  fireEvent.click(screen.getByRole('combobox', { name: 'Voice' }));
  fireEvent.pointerEnter(
    screen.getByRole('button', { name: 'B' }).closest('[data-voice-id]')!,
  );
  act(() => jest.advanceTimersByTime(180));
  expect(dub.previewVoice).toHaveBeenCalledWith('b', undefined, undefined);
  fireEvent.pointerLeave(
    screen.getByRole('button', { name: 'B' }).closest('[data-voice-id]')!,
  );
  expect(dub.stopPreview).toHaveBeenCalled();
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'B' })),
  );
  expect(screen.getByRole('dialog')).toBeVisible();
  fireEvent.change(screen.getByRole('combobox', { name: 'voiceGender' }), {
    target: { value: 'female' },
  });
  expect(screen.queryByRole('button', { name: 'B' })).toBeNull();
  expect(screen.getByRole('button', { name: 'A' })).toBeVisible();
  jest.useRealTimers();
});
