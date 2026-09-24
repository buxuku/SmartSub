import React from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import AiAssistantGuide from '../launchpad/AiAssistantGuide';
import {
  AssistantProvider,
  useAssistant,
} from '../../context/AssistantContext';

jest.mock('next/router', () => ({
  useRouter: () => ({ asPath: '/zh/home', query: { locale: 'zh' } }),
}));

jest.mock('next-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: any) => {
      if (opts?.shortcut) return `${key}:${opts.shortcut}`;
      return key;
    },
  }),
}));

describe('AiAssistantGuide', () => {
  let listeners: Map<string, (event?: any) => void>;
  let invoke: jest.Mock;

  beforeEach(() => {
    listeners = new Map();
    invoke = jest.fn(async (channel: string) => {
      if (channel === 'assistant:providers') return [];
      if (channel === 'assistant:context') return {};
      return null;
    });
    window.ipc = {
      invoke,
      on: jest.fn((channel: string, listener: any) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      }),
    } as any;
  });

  test('renders AI assistant header, pain points, and guidance', async () => {
    render(
      <AssistantProvider>
        <AiAssistantGuide locale="zh" />
      </AssistantProvider>,
    );

    expect(screen.getByText('aiGuide.title')).toBeInTheDocument();
    expect(screen.getByText('aiGuide.desc')).toBeInTheDocument();
    expect(
      screen.getByText('aiGuide.painPoints.modelSelection.title'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('aiGuide.painPoints.paramTuning.title'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('aiGuide.painPoints.omnipresent.title'),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(
        screen.getByText('aiGuide.notConfigured.title'),
      ).toBeInTheDocument();
    });
  });

  test('guides user to configure service when no AI providers exist', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'assistant:providers') return [];
      return null;
    });

    render(
      <AssistantProvider>
        <AiAssistantGuide locale="zh" />
      </AssistantProvider>,
    );

    await waitFor(() => {
      expect(
        screen.getByText('aiGuide.notConfigured.title'),
      ).toBeInTheDocument();
    });

    expect(screen.getByText('aiGuide.notConfigured.desc')).toBeInTheDocument();

    const configLink = screen.getByRole('link', {
      name: /aiGuide\.notConfigured\.action/,
    });
    expect(configLink).toHaveAttribute('href', '/zh/translation');

    const openButton = screen.getByRole('button', {
      name: /aiGuide\.openAssistant/,
    });
    expect(openButton).toBeInTheDocument();
  });

  test('shows ready state and toggles assistant when AI service is configured', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'assistant:providers') {
        return [{ id: 'p1', name: 'DeepSeek', modelName: 'deepseek-chat' }];
      }
      return null;
    });

    function Consumer() {
      const assistant = useAssistant()!;
      return (
        <div>
          <span data-testid="assistant-state">
            {assistant.open ? 'open' : 'closed'}
          </span>
          <AiAssistantGuide locale="zh" />
        </div>
      );
    }

    render(
      <AssistantProvider>
        <Consumer />
      </AssistantProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('aiGuide.configured.title')).toBeInTheDocument();
    });

    expect(screen.getByTestId('assistant-state')).toHaveTextContent('closed');

    const toggleBtn = screen.getByRole('button', {
      name: /aiGuide\.openAssistant/,
    });
    fireEvent.click(toggleBtn);

    expect(screen.getByTestId('assistant-state')).toHaveTextContent('open');

    // Button label reflects open state
    expect(
      screen.getByRole('button', { name: /aiGuide\.closeAssistant/ }),
    ).toBeInTheDocument();

    // Clicking again closes it
    fireEvent.click(
      screen.getByRole('button', { name: /aiGuide\.closeAssistant/ }),
    );
    expect(screen.getByTestId('assistant-state')).toHaveTextContent('closed');
  });

  test('re-checks providers when assistant:event fires', async () => {
    let providers: any[] = [];
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'assistant:providers') return providers;
      return null;
    });

    render(
      <AssistantProvider>
        <AiAssistantGuide locale="zh" />
      </AssistantProvider>,
    );

    await waitFor(() => {
      expect(
        screen.getByText('aiGuide.notConfigured.title'),
      ).toBeInTheDocument();
    });

    // Provider added dynamically
    providers = [{ id: 'p2', name: 'OpenAI', modelName: 'gpt-4o' }];
    act(() => {
      listeners.get('assistant:event')?.({ type: 'providers' });
    });

    await waitFor(() => {
      expect(screen.getByText('aiGuide.configured.title')).toBeInTheDocument();
    });
  });
});
