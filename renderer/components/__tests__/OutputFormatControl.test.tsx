import { fireEvent, render, screen, within } from '@testing-library/react';
import OutputFormatControl from '../tasks/OutputFormatControl';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: any) => options?.defaultValue || key,
  }),
}));

const typeDef = {
  slug: 'generate-translate',
  taskType: 'generateAndTranslate',
  accepts: 'media',
  needsModel: true,
  hasTranslate: true,
} as any;

const renderControl = (formData: Record<string, unknown>) =>
  render(
    <OutputFormatControl
      form={{ setValue: jest.fn() }}
      formData={formData}
      typeDef={typeDef}
    />,
  );

const trigger = () =>
  screen.getByRole('button', { name: 'subtitleOutputFormat' });

describe('the output style summary', () => {
  test('shows translation only when no style is stored, the default the main process applies', () => {
    renderControl({});
    expect(trigger()).toHaveTextContent('outputTranslationOnly');
    expect(trigger()).not.toHaveTextContent('outputSourceFirst');
  });

  test.each([
    ['onlyTranslate', 'outputTranslationOnly'],
    ['sourceAndTranslate', 'outputSourceFirst'],
    ['translateAndSource', 'outputTranslationFirst'],
  ])('summarizes a stored %s style as %s', (translateContent, label) => {
    renderControl({ translateContent });
    expect(trigger()).toHaveTextContent(label);
  });

  test('explains an unset style with the translation-only layout example', () => {
    renderControl({});
    fireEvent.click(trigger());
    const example = screen.getByLabelText('outputExample');
    expect(within(example).getByText('outputExampleTarget')).toBeVisible();
    expect(within(example).queryByText('outputExampleSource')).toBeNull();
  });
});
