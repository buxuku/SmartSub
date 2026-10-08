import type { ComponentProps } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import DeleteModel from '../DeleteModel';

// Strings come from the real English file, so a wrong key or a renamed {{path}}
// variable fails here instead of showing the user a bare key.
jest.mock('next-i18next', () => {
  const common = require('../../public/locales/en/common.json');
  const t = (key: string, vars: Record<string, string> = {}) =>
    String(common[key] ?? `MISSING:${key}`).replace(
      /\{\{(\w+)\}\}/g,
      (_match, name) => vars[name] ?? `MISSING:${name}`,
    );
  return { useTranslation: () => ({ t }) };
});
jest.mock('sonner', () => ({ toast: { warning: jest.fn() } }));

const KEPT = '/cache/hub/models--Systran--faster-whisper-large-v3';

/** Opens the confirm dialog, confirms, and waits until the delete has finished. */
async function confirmDelete(
  props: Partial<ComponentProps<typeof DeleteModel>>,
  ipcResult: unknown,
) {
  const callBack = jest.fn();
  const invoke = jest.fn(async () => ipcResult);
  window.ipc = { invoke } as any;
  render(
    <DeleteModel modelName="large-v3" callBack={callBack} {...props}>
      <button>open</button>
    </DeleteModel>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'open' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(callBack).toHaveBeenCalledTimes(1));
  return { invoke };
}

test('says which folder a CT2 delete kept, so the model still in the list is explained', async () => {
  const { invoke } = await confirmDelete(
    { format: 'ct2' },
    { success: true, skipped: [KEPT] },
  );

  expect(invoke).toHaveBeenCalledWith('deleteCt2Model', 'large-v3');
  expect(toast.warning).toHaveBeenCalledTimes(1);
  const [message] = (toast.warning as jest.Mock).mock.calls[0];
  expect(message).toContain('Not deleted');
  expect(message).toContain(KEPT);
});

test('stays quiet when a CT2 delete removed everything it found', async () => {
  await confirmDelete({ format: 'ct2' }, { success: true, skipped: [] });

  expect(toast.warning).not.toHaveBeenCalled();
});

test('the ggml delete, which answers with a bare true, is unaffected', async () => {
  const { invoke } = await confirmDelete({ modelName: 'base' }, true);

  expect(invoke).toHaveBeenCalledWith('deleteModel', 'base');
  expect(toast.warning).not.toHaveBeenCalled();
});
