import {
  dubbingConfigFromSelection,
  resolveDubbingSelection,
  selectComposeStyle,
  initialComposeConfig,
  withComposeDefaults,
} from '../pipelineSettings';
import { TaskDraftManager } from '../taskDraftManager';

const engines: any[] = [
  {
    key: 'cloud:ready',
    kind: 'cloud',
    ready: true,
    label: 'Ready',
    voices: [{ id: 'alice', label: 'Alice' }],
    defaultVoiceId: 'alice',
  },
];

test('defaults are used for a new dubbing selection only', () => {
  expect(
    resolveDubbingSelection({ engineKey: '', voice: '' }, engines),
  ).toMatchObject({ engineKey: 'cloud:ready', voice: 'alice' });
  expect(
    resolveDubbingSelection(
      { engineKey: 'cloud:deleted', voice: 'old' },
      engines,
    ),
  ).toMatchObject({ engineKey: 'cloud:deleted', voice: 'old' });
  expect(
    resolveDubbingSelection(
      { engineKey: 'cloud:ready', voice: 'deleted' },
      engines,
    ).voice,
  ).toBe('deleted');
});

test('dubbing payload preserves advanced settings and explicit speed', () => {
  expect(
    dubbingConfigFromSelection({
      engineKey: 'cloud:ready',
      voice: 'alice',
      globalSpeed: 1.25,
      overflow: 'shift',
      overlapMode: 'mix',
      localConcurrency: 3,
    } as any),
  ).toMatchObject({
    engine: { kind: 'cloud', providerId: 'ready' },
    globalSpeed: 1.25,
    overflow: 'shift',
    overlapMode: 'mix',
    localConcurrency: 3,
  });
});

test('new and cleared composition drafts inherit preferences, including late loads', () => {
  const fresh = initialComposeConfig((key) => key);
  expect(
    withComposeDefaults(fresh, {
      videoQuality: 'high',
      encoderMode: 'hardware',
    }),
  ).toMatchObject({ videoQuality: 'high', encoderMode: 'hardware' });
  expect(withComposeDefaults(fresh, {})).toMatchObject({
    videoQuality: 'original',
    encoderMode: 'cpu',
  });
  expect(fresh.videoQuality).toBeUndefined();
});

test('partial recipes inherit only missing fields and preserve explicit choices', () => {
  const partial = {
    ...initialComposeConfig((key) => key),
    subtitle: 'soft' as const,
    videoQuality: 'standard' as const,
  };
  expect(
    withComposeDefaults(partial, {
      videoQuality: 'high',
      encoderMode: 'hardware',
    }),
  ).toMatchObject({
    subtitle: 'soft',
    videoQuality: 'standard',
    encoderMode: 'hardware',
  });
});

test('choosing a style snapshots it without replacing composition settings', () => {
  const config: any = {
    subtitle: 'hard',
    styleId: 'old',
    style: { fontName: 'Old' },
    videoQuality: 'high',
    encoderMode: 'hardware',
    custom: 'kept',
  };
  const presets: any[] = [
    { id: 'mine', name: 'My style', style: { fontName: 'Saved' } },
  ];
  const next = selectComposeStyle(config, 'mine', presets, (key) => key);
  expect(next).toMatchObject({
    styleId: 'mine',
    styleName: 'My style',
    style: { fontName: 'Saved' },
    videoQuality: 'high',
    encoderMode: 'hardware',
    custom: 'kept',
  });
  presets[0].style.fontName = 'Changed later';
  expect(next.style?.fontName).toBe('Saved');
  expect(selectComposeStyle(config, 'missing', [], (key) => key)).toBe(config);
});

test('wizard draft recovery retains the exact composition style payload', () => {
  const manager = new TaskDraftManager();
  const compose = {
    ...initialComposeConfig((key) => key),
    styleId: 'removed-preset',
    styleName: 'Saved style',
  };
  const draft = {
    files: [{ filePath: '/clip.mp4', fileName: 'clip' }],
    savedAt: 1,
    pipeline: {
      dubbing: {},
      compose,
      subtitle: 'hard' as const,
      styleId: 'removed-preset',
      quality: 'high',
      encoder: 'hardware',
      subtitleGate: true,
      dubbingGate: false,
      recipeName: 'Saved recipe',
    },
  };
  expect(
    manager.deserializeDraft(manager.serializeDraft(draft))?.pipeline?.compose,
  ).toEqual(compose);
});
