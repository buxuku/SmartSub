import React from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import ContextGlossary from '../proofread/ContextGlossary';
import type { NavigationGuardOptions } from '../../context/NavigationGuardContext';
import type { Subtitle } from '../../hooks/useSubtitles';

let mockGuard: NavigationGuardOptions;
jest.mock('@/context/NavigationGuardContext', () => ({
  useNavigationGuard: (_id: string, options: NavigationGuardOptions) => {
    mockGuard = options;
  },
}));
jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let cues: Subtitle[];
let invoke: jest.Mock;
let update: jest.Mock;
function Harness({
  documentKey = 'first',
  ensureProject,
}: {
  documentKey?: string;
  ensureProject?: () => Promise<string | undefined>;
}) {
  return (
    <React.StrictMode>
      <ContextGlossary
        documentKey={documentKey}
        projectId={ensureProject ? undefined : 'a'}
        ensureProject={ensureProject}
        getSubtitles={() => cues}
        updateSubtitles={update}
        shouldShowTranslation
      >
        <textarea id="subtitle-src-0" defaultValue="Alice arrived" />
      </ContextGlossary>
    </React.StrictMode>
  );
}
function open() {
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  input.setSelectionRange(0, 5);
  fireEvent.mouseUp(input);
  fireEvent.click(screen.getByRole('button', { name: 'contextGlossary.add' }));
  fireEvent.change(
    screen.getByRole('textbox', { name: 'contextGlossary.target' }),
    { target: { value: 'Alicia' } },
  );
}
beforeEach(() => {
  cues = [
    {
      id: '1',
      startEndTime: '1',
      startTimeInSeconds: 0,
      endTimeInSeconds: 1,
      content: ['Alice arrived'],
      sourceContent: 'Alice arrived',
      targetContent: 'Alice came',
    },
  ];
  invoke = jest
    .fn()
    .mockResolvedValue({ success: true, data: { entry: { id: 'saved' } } });
  window.ipc = { invoke } as any;
  update = jest.fn();
});
it('saves in StrictMode and exposes a working save-and-leave guard', async () => {
  render(<Harness />);
  open();
  expect(mockGuard.getIsDirty?.()).toBe(true);
  let saved;
  await act(async () => {
    saved = await mockGuard.onSave?.();
  });
  expect(saved).toBe(true);
  expect(mockGuard.getIsDirty?.()).toBe(false);
  expect(invoke).toHaveBeenCalledWith(
    'glossaries:add-context-entry',
    expect.objectContaining({
      source: 'Alice',
      target: 'Alicia',
      scope: 'project',
      projectId: 'a',
    }),
  );
  expect(screen.getByRole('heading')).toHaveTextContent(
    'contextGlossary.replaceTitle',
  );
});
it('rejects stale replacement and permits a fresh preview', async () => {
  render(<Harness />);
  open();
  fireEvent.click(screen.getByRole('button', { name: 'contextGlossary.save' }));
  await screen.findByRole('button', { name: 'contextGlossary.replaceAll' });
  cues = [{ ...cues[0], targetContent: 'Alice manually edited' }];
  fireEvent.click(
    screen.getByRole('button', { name: 'contextGlossary.replaceAll' }),
  );
  expect(update).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('contextGlossary.stale');
  fireEvent.click(
    screen.getByRole('button', { name: 'contextGlossary.count' }),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'contextGlossary.replaceAll' }),
  );
  expect(update).toHaveBeenCalledWith([
    expect.objectContaining({
      sourceContent: 'Alice arrived',
      targetContent: 'Alicia manually edited',
    }),
  ]);
});
it('does not persist to a new document after awaiting project creation', async () => {
  let release!: (id: string) => void;
  const ensureProject = () =>
    new Promise<string>((resolve) => {
      release = resolve;
    });
  const { rerender } = render(<Harness ensureProject={ensureProject} />);
  open();
  fireEvent.click(screen.getByRole('button', { name: 'contextGlossary.save' }));
  rerender(<Harness documentKey="second" ensureProject={ensureProject} />);
  await act(async () => release('previous-project'));
  expect(invoke).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('keeps failures dirty and sends compare-and-swap only after confirmation', async () => {
  invoke.mockResolvedValueOnce({
    success: false,
    error: 'ENTRY_CONFLICT',
    data: { entry: { target: 'Existing' } },
  });
  render(<Harness />);
  open();
  fireEvent.click(screen.getByRole('button', { name: 'contextGlossary.save' }));
  const overwrite = await screen.findByRole('button', {
    name: 'contextGlossary.overwrite',
  });
  expect(mockGuard.getIsDirty?.()).toBe(true);
  expect(invoke.mock.calls[0][1].expectedTarget).toBeUndefined();
  fireEvent.click(overwrite);
  await waitFor(() => expect(mockGuard.getIsDirty?.()).toBe(false));
  expect(invoke.mock.calls[1][1].expectedTarget).toBe('Existing');
});
it('ignores a late IPC result after a document switch', async () => {
  let release!: (value: unknown) => void;
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const { rerender } = render(<Harness />);
  open();
  fireEvent.click(screen.getByRole('button', { name: 'contextGlossary.save' }));
  rerender(<Harness documentKey="second" />);
  await act(async () =>
    release({ success: true, data: { entry: { id: 'previous' } } }),
  );
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(update).not.toHaveBeenCalled();
});
