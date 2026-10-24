import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import TaskConfigSections from '../tasks/TaskConfigSections';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('../../hooks/useTtsEngineOptions', () => ({
  useTtsEngineOptions: () => ({ engineOptions: [] }),
}));
jest.mock('../../hooks/useComposeOptions', () => ({
  __esModule: true,
  default: () => ({ styles: [], hwInfo: null, preferences: {}, loaded: true }),
}));
jest.mock('../tasks/settings/PipelineSettings', () => ({
  DubbingSettings: ({ disabled, onChange, value }: any) => (
    <button
      disabled={disabled}
      onClick={() => onChange({ ...value, globalSpeed: 1.25 })}
    >
      change voice settings
    </button>
  ),
  ComposeSettings: ({ disabled, onChange, value }: any) => (
    <button
      disabled={disabled}
      onClick={() => onChange({ ...value, videoQuality: 'high' })}
    >
      change compose settings
    </button>
  ),
  ReviewSettings: ({ disabled }: any) => (
    <button disabled={disabled}>change review settings</button>
  ),
}));

const config = {
  taskType: 'generateAndTranslate',
  translateProvider: 'p',
  dub: {
    engine: { kind: 'cloud', providerId: 'p' },
    voice: 'a',
    globalSpeed: 1,
  },
  compose: { subtitle: 'hard', style: { fontName: 'Saved' } },
};
const form = { setValue: jest.fn() };
const renderSections = (formData: any, disabled = false) => (
  <TaskConfigSections form={form} formData={formData} disabled={disabled}>
    <button disabled={disabled}>subtitle settings</button>
  </TaskConfigSections>
);
const choose = (name: string) =>
  fireEvent.mouseDown(screen.getByRole('tab', { name }), {
    button: 0,
    ctrlKey: false,
  });

test('ordinary subtitle tasks retain their compact toolbar', () => {
  render(renderSections({ taskType: 'generateOnly' }));
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'subtitle settings' }),
  ).toBeEnabled();
});

test('only enabled pipeline stages have groups, and editing updates the task form', () => {
  render(renderSections(config));
  choose('stageSettings.dubbing');
  fireEvent.click(
    screen.getByRole('button', { name: 'change voice settings' }),
  );
  expect(form.setValue).toHaveBeenCalledWith(
    'dub',
    { ...config.dub, globalSpeed: 1.25 },
    { shouldDirty: true },
  );
  choose('stageSettings.compose');
  fireEvent.click(
    screen.getByRole('button', { name: 'change compose settings' }),
  );
  expect(form.setValue).toHaveBeenCalledWith(
    'compose',
    { ...config.compose, videoQuality: 'high' },
    { shouldDirty: true },
  );
});

test('locked settings remain inspectable through section navigation', () => {
  const view = render(renderSections(config, true));
  expect(
    screen.getByRole('tab', { name: 'stageSettings.dubbing' }),
  ).toBeEnabled();
  choose('stageSettings.dubbing');
  expect(
    screen.getByRole('button', { name: 'change voice settings' }),
  ).toBeDisabled();
  choose('stageSettings.review');
  expect(
    screen.getByRole('button', { name: 'change review settings' }),
  ).toBeDisabled();
  view.rerender(renderSections(config));
  expect(
    screen.getByRole('button', { name: 'change review settings' }),
  ).toBeEnabled();
});

test('a dubbing-only task has no composition controls', () => {
  render(renderSections({ ...config, compose: undefined }));
  expect(
    screen.queryByRole('tab', { name: 'stageSettings.compose' }),
  ).not.toBeInTheDocument();
});
