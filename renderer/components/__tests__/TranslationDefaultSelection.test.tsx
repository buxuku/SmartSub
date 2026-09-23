import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ProvidersTab from '../resources/ProvidersTab';

jest.mock('../../context/NavigationGuardContext', () => ({
  useNavigationGuard: jest.fn(),
}));
jest.mock('../../hooks/useConfirmOrUndo', () => ({
  useConfirmOrUndo: () => jest.fn(),
}));
jest.mock('next-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: any) => options?.defaultValue || key,
  }),
}));
jest.mock('../resources/TranslationOverviewPanel', () => ({
  __esModule: true,
  default: ({ onSelectProvider }: any) => (
    <button onClick={() => onSelectProvider('autoFree')}>
      Browse free service
    </button>
  ),
}));

test('viewing a service leaves defaults unchanged until the explicit action succeeds', async () => {
  localStorage.clear();
  const invoke = jest.fn(async (channel: string) => {
    if (channel === 'getTranslationProviders')
      return [
        { id: 'autoFree', type: 'autoFree', name: 'autoFree', isAi: false },
      ];
    if (channel === 'getUserConfig') return { translateProvider: 'googleFree' };
    return { success: true };
  });
  window.ipc = { invoke } as any;
  render(<ProvidersTab />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Browse free service' }),
  );
  const setDefault = await screen.findByRole('button', {
    name: 'setAsDefault',
  });
  expect(
    invoke.mock.calls.some(
      ([channel]) => channel === 'setDefaultTranslationProvider',
    ),
  ).toBe(false);
  fireEvent.click(setDefault);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'setDefaultTranslationProvider',
      'autoFree',
    ),
  );
  expect(
    await screen.findByRole('button', { name: 'currentDefault' }),
  ).toBeDisabled();
});
