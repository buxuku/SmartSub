import React from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import TaskRowList from '../tasks/TaskRowList';
import LogPanel from '../tasks/LogPanel';
import { TASK_TYPES } from '../../lib/taskTypes';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

it('keeps only the latest 200 initial and live log entries', async () => {
  let onLog: (value: any) => void;
  const log = (index: number) => ({
    projectId: 'project',
    timestamp: index,
    message: `message-${index}`,
  });
  (window as any).ipc = {
    invoke: jest
      .fn()
      .mockResolvedValue(Array.from({ length: 300 }, (_, i) => log(i))),
    on: jest.fn((_channel, callback) => {
      onLog = callback;
      return jest.fn();
    }),
  };
  render(<LogPanel projectId="project" />);
  await screen.findByText('message-299');
  fireEvent.click(screen.getByRole('button', { name: /logs.title/ }));
  expect(screen.queryByText('message-99')).not.toBeInTheDocument();
  expect(screen.getByText('message-100')).toBeInTheDocument();
  act(() => {
    for (let index = 300; index < 1000; index++) onLog(log(index));
    onLog({ ...log(1000), projectId: 'another-project' });
  });
  expect(screen.queryByText('message-799')).not.toBeInTheDocument();
  expect(screen.getByText('message-800')).toBeInTheDocument();
  expect(screen.getByText('message-999')).toBeInTheDocument();
  expect(screen.queryByText('message-1000')).not.toBeInTheDocument();
});

it('mounts a bounded number of task rows and can scroll to the end of a large batch', async () => {
  const measure = jest
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function () {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1200,
        bottom: 112,
        width: 1200,
        height: 112,
        toJSON() {},
      };
    });
  const viewport = document.createElement('div');
  const rowHeight = jest
    .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
    .mockReturnValue(112);
  Object.defineProperties(viewport, {
    offsetHeight: { value: 480 },
    offsetWidth: { value: 1200 },
  });
  const scrollRef = { current: viewport };
  document.body.append(viewport);
  const files = Array.from({ length: 200 }, (_, index) => ({
    uuid: `file-${index}`,
    fileName: `audio-${index}`,
    filePath: `/audio-${index}.wav`,
    fileExtension: '.wav',
  }));
  const onDelete = jest.fn();
  try {
    render(
      <TaskRowList
        files={files}
        typeDef={TASK_TYPES[1]}
        formData={{ taskType: 'generateOnly' }}
        taskStatus="idle"
        scrollElementRef={scrollRef}
        onProofread={jest.fn()}
        onDelete={onDelete}
        onRetry={jest.fn()}
      />,
      { container: viewport },
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('task-row').length).toBeLessThan(30);
    });
    expect(screen.getByText('audio-0')).toBeInTheDocument();
    expect(screen.queryByText('audio-199')).not.toBeInTheDocument();
    viewport.scrollTop = 200 * 120 - 480;
    fireEvent.scroll(viewport);
    await screen.findByText('audio-199');
    expect(screen.queryByText('audio-0')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('task-row').length).toBeLessThan(30);
    const last = screen
      .getByText('audio-199')
      .closest('[data-testid="task-row"]')!;
    fireEvent.click(last.querySelector('button[aria-label="row.remove"]')!);
    expect(onDelete).toHaveBeenCalledWith('file-199');
  } finally {
    viewport.remove();
    measure.mockRestore();
    rowHeight.mockRestore();
  }
});
