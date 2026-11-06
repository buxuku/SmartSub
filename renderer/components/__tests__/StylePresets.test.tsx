import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import StylePresets from '../subtitleMerge/StylePresets';
import { getDefaultStyle } from '../subtitleMerge/constants';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

it('shows persistent save failure inside the dialog, retains its name, and guards repeated Enter/close during save', async () => {
  let release!: (value: unknown) => void;
  const save = jest.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  render(
    <StylePresets
      activePresetId={null}
      onSelectPreset={jest.fn()}
      userPresets={[]}
      onSaveStylePreset={save}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'saveStyleAsPreset' }));
  const dialog = screen.getByRole('dialog');
  const input = within(dialog).getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Retry me' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(save).toHaveBeenCalledTimes(1);
  expect(within(dialog).getByRole('button', { name: 'cancel' })).toBeDisabled();
  expect(input).toBeDisabled();
  await act(async () => release(null));
  expect(within(dialog).getByRole('alert')).toHaveTextContent(
    'presetSaveFailed',
  );
  expect(input).toHaveValue('Retry me');
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'savePresetConfirm' }),
  );
  expect(save).toHaveBeenCalledTimes(2);
  expect(within(dialog).getByRole('alert')).toBeVisible();
  await act(async () =>
    release({ id: 'saved', name: 'Retry me', style: getDefaultStyle() }),
  );
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('does not select a preset when Enter bubbles from its delete control', async () => {
  const select = jest.fn();
  const remove = jest.fn().mockResolvedValue(true);
  render(
    <StylePresets
      activePresetId={null}
      onSelectPreset={select}
      userPresets={[
        {
          id: 'saved',
          name: 'Saved',
          style: getDefaultStyle(),
          createdAt: 1,
          updatedAt: 1,
        },
      ]}
      onDeleteStylePreset={remove}
    />,
  );
  const button = screen.getByRole('button', { name: 'deletePreset' });
  fireEvent.keyDown(button, { key: 'Enter' });
  await act(async () => fireEvent.click(button));
  expect(remove).toHaveBeenCalledWith('saved');
  expect(select).not.toHaveBeenCalled();
});
