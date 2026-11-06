import type { ComponentProps } from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import DeleteModel from '../DeleteModel';

// Strings come from the real English file, so a wrong key fails here instead of
// showing the user a bare key.
jest.mock('next-i18next', () => {
  const common = require('../../public/locales/en/common.json');
  const t = (key: string) => String(common[key] ?? `MISSING:${key}`);
  return { useTranslation: () => ({ t }) };
});

const HUB_COPY = '/cache/hub/models--Systran--faster-whisper-large-v3';
const ROOT_COPY = '/cache/models--Systran--faster-whisper-large-v3';

type Handlers = Record<string, (...args: unknown[]) => unknown>;

/** Renders the dialog against a fake main process, answering per IPC channel. */
function setup(
  props: Partial<ComponentProps<typeof DeleteModel>>,
  handlers: Handlers,
) {
  const callBack = jest.fn();
  const invoke = jest.fn(async (channel: string, ...args: unknown[]) =>
    handlers[channel]?.(...args),
  );
  window.ipc = { invoke } as any;
  render(
    <DeleteModel modelName="large-v3" callBack={callBack} {...props}>
      <button>open</button>
    </DeleteModel>,
  );
  return { invoke, callBack };
}

const openDialog = () =>
  fireEvent.click(screen.getByRole('button', { name: 'open' }));

const folderLookupDone = (invoke: jest.Mock) =>
  waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('getCt2DeleteTargets', 'large-v3'),
  );

test('a CT2 delete lists every folder it will remove and warns they may be shared', async () => {
  const { invoke } = setup(
    { format: 'ct2' },
    { getCt2DeleteTargets: () => [HUB_COPY, ROOT_COPY] },
  );

  openDialog();

  expect(await screen.findByText(HUB_COPY)).toBeInTheDocument();
  expect(screen.getByText(ROOT_COPY)).toBeInTheDocument();
  expect(screen.getByText(/deleted from disk/i)).toBeInTheDocument();
  expect(
    screen.getByText(/shared with other HuggingFace apps/i),
  ).toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith('getCt2DeleteTargets', 'large-v3');
});

test('confirming a CT2 delete still deletes by model id and refreshes the list', async () => {
  const { invoke, callBack } = setup(
    { format: 'ct2' },
    { getCt2DeleteTargets: () => [HUB_COPY], deleteCt2Model: () => true },
  );
  openDialog();
  await screen.findByText(HUB_COPY);

  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

  await waitFor(() => expect(callBack).toHaveBeenCalledTimes(1));
  expect(invoke).toHaveBeenCalledWith('deleteCt2Model', 'large-v3');
});

test('says nothing about folders when the model is not on disk', async () => {
  const { invoke } = setup(
    { format: 'ct2' },
    { getCt2DeleteTargets: () => [] },
  );

  openDialog();
  await folderLookupDone(invoke);
  await act(async () => {});

  expect(screen.queryByText(/deleted from disk/i)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
});

test('a failing folder lookup does not stop the delete', async () => {
  const { invoke, callBack } = setup(
    { format: 'ct2' },
    {
      getCt2DeleteTargets: () => {
        throw new Error('lookup failed');
      },
      deleteCt2Model: () => true,
    },
  );

  openDialog();
  await folderLookupDone(invoke);
  await act(async () => {});
  expect(screen.queryByText(/deleted from disk/i)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

  await waitFor(() => expect(callBack).toHaveBeenCalledTimes(1));
  expect(invoke).toHaveBeenCalledWith('deleteCt2Model', 'large-v3');
});

test('the ggml dialog never looks up folders', async () => {
  const { invoke, callBack } = setup(
    { modelName: 'base' },
    { deleteModel: () => true },
  );

  openDialog();
  fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

  await waitFor(() => expect(callBack).toHaveBeenCalledTimes(1));
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith('deleteModel', 'base');
});
