import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  AssistantProvider,
  useAssistant,
  useAssistantSource,
} from '../AssistantContext';

jest.mock('next/router', () => ({
  useRouter: () => ({ asPath: '/en/translation', query: {} }),
}));

function Workspace() {
  const assistant = useAssistant()!;
  return (
    <>
      <output>{assistant.open ? 'open' : 'closed'}</output>
      <textarea aria-label="Draft" />
    </>
  );
}

test.each([
  ['MacIntel', { metaKey: true }, { ctrlKey: true }],
  ['Win32', { ctrlKey: true }, { metaKey: true }],
  ['Linux x86_64', { ctrlKey: true }, { metaKey: true }],
])(
  'assistant shortcut toggles from the workspace and inputs on %s',
  (platform, modifier, wrongModifier) => {
    Object.defineProperty(navigator, 'platform', {
      value: platform,
      configurable: true,
    });
    window.ipc = { invoke: jest.fn(async () => true), on: jest.fn() } as any;
    render(
      <AssistantProvider>
        <Workspace />
      </AssistantProvider>,
    );
    expect(screen.getByText('closed')).toBeVisible();
    fireEvent.keyDown(document.body, { key: 'j', ...wrongModifier });
    expect(screen.getByText('closed')).toBeVisible();
    expect(fireEvent.keyDown(document.body, { key: 'j', ...modifier })).toBe(
      false,
    );
    expect(screen.getByText('open')).toBeVisible();
    const draft = screen.getByLabelText('Draft');
    fireEvent.change(draft, { target: { value: 'Keep this draft' } });
    fireEvent.keyDown(draft, { key: 'j', ...modifier, repeat: true });
    fireEvent.keyDown(draft, { key: 'j', ...modifier, isComposing: true });
    fireEvent.keyDown(draft, { key: 'J', ...modifier, shiftKey: true });
    expect(screen.getByText('open')).toBeVisible();
    fireEvent.keyDown(draft, { key: 'j', ...modifier });
    expect(screen.getByText('closed')).toBeVisible();
    expect(draft).toHaveValue('Keep this draft');
    fireEvent.keyDown(draft, { key: 'j', ...modifier });
    expect(screen.getByText('open')).toBeVisible();
  },
);

test('captures recent error logs from newLog events into assistant context', () => {
  let logHandler: ((log: any) => void) | undefined;
  window.ipc = {
    invoke: jest.fn(async () => true),
    on: jest.fn((channel, handler) => {
      if (channel === 'newLog') logHandler = handler;
      return () => {};
    }),
  } as any;

  let captured: any;
  function TestConsumer() {
    const assistant = useAssistant()!;
    return (
      <button onClick={() => (captured = assistant.capture())}>Capture</button>
    );
  }

  render(
    <AssistantProvider>
      <TestConsumer />
    </AssistantProvider>,
  );

  // Send non-error log; should not be captured
  act(() => {
    logHandler?.({ message: 'Normal info', type: 'info', timestamp: 1000 });
  });
  fireEvent.click(screen.getByText('Capture'));
  expect(captured.recentErrors).toBeUndefined();

  // Send error log; should be captured
  act(() => {
    logHandler?.({
      message: 'CUDA device error: out of memory',
      type: 'error',
      timestamp: 2000,
    });
  });
  fireEvent.click(screen.getByText('Capture'));
  expect(captured.recentErrors).toEqual(['CUDA device error: out of memory']);
});

test('source-provided recentErrors are merged into assistant context snapshot', () => {
  window.ipc = { invoke: jest.fn(async () => true), on: jest.fn() } as any;

  function TaskComponent() {
    useAssistantSource(
      {
        priority: 10,
        snapshot: () => ({
          projectId: 'task-1',
          recentErrors: ['Model download failed'],
        }),
      },
      [],
    );
    const assistant = useAssistant()!;
    return (
      <button onClick={() => (captured = assistant.capture())}>Capture</button>
    );
  }

  let captured: any;
  render(
    <AssistantProvider>
      <TaskComponent />
    </AssistantProvider>,
  );

  fireEvent.click(screen.getByText('Capture'));
  expect(captured.projectId).toBe('task-1');
  expect(captured.recentErrors).toEqual(['Model download failed']);
});
