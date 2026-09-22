import React from 'react';
import { randomUUID } from 'node:crypto';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import InlineAiSettings from '../proofread/InlineAiSettings';
import { useInlineAi } from '../../hooks/useInlineAi';
import zh from '../../public/locales/zh/home.json';

const cues = [0, 1].map((index) => ({
  id: String(index),
  startEndTime: '',
  content: [],
  sourceContent: `Source ${index}`,
  targetContent: `Target ${index}`,
}));

it('keeps template selection separate from execution and saves each prompt independently', async () => {
  localStorage.clear();
  Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    value: randomUUID,
  });
  const invoke = jest.fn(async (channel) =>
    channel === 'getAiTranslationProviders'
      ? {
          success: true,
          data: [
            {
              id: 'fixture',
              name: 'Fixture',
              type: 'openai',
              isAi: true,
              apiKey: 'test',
              apiUrl: 'http://localhost',
              modelName: 'fixture',
            },
          ],
        }
      : { success: true, data: 'Edited text' },
  );
  Object.defineProperty(window, 'ipc', {
    configurable: true,
    value: { invoke, on: () => () => {} },
  });
  const i18n = createInstance();
  await i18n.init({ lng: 'zh', resources: { zh: { home: zh } } });
  function Harness() {
    const control = useInlineAi({
      documentKey: 'settings-test',
      getSubtitles: () => cues,
      updateSubtitles() {},
      shouldShowTranslation: true,
    });
    return (
      <>
        <InlineAiSettings control={control} />
        <button
          onClick={() => void control.run([0], 'shorten', 'sourceContent')}
        >
          Run source shortening
        </button>
        <button
          onClick={() => void control.run([0], 'polish', 'targetContent')}
        >
          Run translation polish
        </button>
      </>
    );
  }
  render(
    <I18nextProvider i18n={i18n}>
      <Harness />
    </I18nextProvider>,
  );
  await waitFor(() =>
    expect(
      screen.getByRole('combobox', { name: '选择 AI 服务' }),
    ).toHaveTextContent('Fixture'),
  );
  expect(screen.queryByRole('textbox', { name: '提示词内容' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '高级设置（可选）' }));
  const templates = screen.getByRole('combobox', {
    name: '要编辑的提示词模板',
  });
  fireEvent.change(templates, {
    target: { value: 'sourceContent:single:shorten' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: '提示词内容' }), {
    target: { value: 'Custom source shortening' },
  });
  expect(localStorage.getItem('ai_proofread_custom_prompt_shorten')).toBe(
    'Custom source shortening',
  );
  fireEvent.change(templates, {
    target: { value: 'targetContent:batch:polish' },
  });
  expect(screen.getByRole('textbox', { name: '提示词内容' })).not.toHaveValue(
    'Custom source shortening',
  );
  expect(invoke).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByText('Run source shortening'));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'optimizeSubtitle',
      expect.objectContaining({
        providerId: 'fixture',
        mode: 'transcript',
        intent: 'shorten',
        customPrompt: 'Custom source shortening',
      }),
    ),
  );
  // Running an operation must not change which template the settings editor shows.
  expect(templates).toHaveValue('targetContent:batch:polish');
  fireEvent.click(screen.getByText('Run translation polish'));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'optimizeSubtitle',
      expect.objectContaining({
        providerId: 'fixture',
        mode: 'translation',
        intent: 'polish',
      }),
    ),
  );
  fireEvent.change(templates, {
    target: { value: 'sourceContent:single:shorten' },
  });
  expect(screen.getByRole('textbox', { name: '提示词内容' })).toHaveValue(
    'Custom source shortening',
  );
  fireEvent.click(
    screen.getByRole('button', { name: '恢复这份模板的默认提示词' }),
  );
  expect(screen.getByRole('textbox', { name: '提示词内容' })).not.toHaveValue(
    'Custom source shortening',
  );
});
