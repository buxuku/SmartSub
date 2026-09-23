import React from 'react';
import { render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import TaskRowList from '../tasks/TaskRowList';
import TaskGridList from '../tasks/TaskGridList';
import { getFileWarning } from '../tasks/stageUtils';
import { TASK_TYPES } from '../../lib/taskTypes';
import zh from '../../public/locales/zh/tasks.json';
import en from '../../public/locales/en/tasks.json';

const completedFile = {
  uuid: 'interrupted-retry',
  filePath: '/tmp/clip.mp4',
  fileName: 'clip',
  fileExtension: '.mp4',
  extractAudio: 'done',
  extractSubtitle: 'done',
  extractSubtitleError: 'TASK_INTERRUPTED',
  missedSpeechSummary: { count: 14, highestLevel: 'medium' },
};

beforeAll(() => {
  global.IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof IntersectionObserver;
});

describe.each([
  ['list', TaskRowList],
  ['grid', TaskGridList],
] as const)('%s task messages', (_name, Component) => {
  it.each(['zh', 'en'])(
    'localizes interruptions in %s and removes them after recovery',
    async (language) => {
      const i18n = createInstance();
      await i18n.init({
        lng: language,
        fallbackLng: false,
        resources: { zh: { tasks: zh }, en: { tasks: en } },
        interpolation: { escapeValue: false },
      });
      const t = i18n.getFixedT(language, 'tasks');
      const view = (file: typeof completedFile) => (
        <I18nextProvider i18n={i18n}>
          <Component
            files={[file]}
            typeDef={TASK_TYPES[1]}
            formData={{ taskType: 'generateOnly' }}
            taskStatus="idle"
            onProofread={jest.fn()}
            onDelete={jest.fn()}
            onRetry={jest.fn()}
          />
        </I18nextProvider>
      );
      const { container, rerender } = render(
        view({ ...completedFile, extractSubtitle: 'error' }),
      );
      expect(screen.getByTestId('task-activity')).toHaveTextContent(
        t('interrupted'),
      );
      expect(container.textContent).not.toContain('TASK_INTERRUPTED');

      // Old saved records can retain an interruption even though retry succeeded.
      rerender(view(completedFile));
      expect(container.textContent).not.toContain('TASK_INTERRUPTED');
      expect(screen.queryByText(t('interrupted'))).toBeNull();
      expect(screen.getByTestId('task-activity')).toHaveTextContent(
        t('row.missedSpeechWarning', {
          count: 14,
          level: t('row.missedSpeechLevel.medium'),
        }),
      );

      rerender(
        view({
          ...completedFile,
          extractSubtitleError: 'AI_CORRECTION_VALIDATION_FAILED:2',
        }),
      );
      expect(container.textContent).toContain(
        t('row.aiCorrectionValidationFailed', { count: 2 }),
      );
      expect(container.textContent).not.toContain(
        'AI_CORRECTION_VALIDATION_FAILED',
      );

      rerender(
        view({
          ...completedFile,
          extractSubtitle: 'error',
          extractSubtitleError: 'Connection timed out',
        }),
      );
      expect(screen.getByTestId('task-activity')).toHaveTextContent(
        'Connection timed out',
      );
    },
  );
});

it('does not let an obsolete interruption hide a later stage warning', () => {
  expect(
    getFileWarning(
      {
        ...completedFile,
        refineSubtitle: 'done',
        refineSubtitleError: 'AI_CORRECTION_VALIDATION_FAILED:2',
      },
      [
        { key: 'extractSubtitle', labelKey: 'stage.transcribe' },
        { key: 'refineSubtitle', labelKey: 'stage.refine' },
      ],
    ),
  ).toBe('AI_CORRECTION_VALIDATION_FAILED:2');
});
