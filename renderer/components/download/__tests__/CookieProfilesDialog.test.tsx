import React from 'react';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import i18next from 'i18next';
import { randomUUID } from 'node:crypto';
import CookieProfilesDialog from '../CookieProfilesDialog';
import type { CookieProfileView } from '../../../../types/download';

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const douyin: CookieProfileView = {
  id: 'douyin',
  kind: 'preset',
  name: 'cookie.presetDouyin',
  isNameLiteral: false,
  configured: true,
  matchDomains: ['douyin.com'],
  cookieDomains: ['douyin.com'],
  cookieCount: 9,
  source: 'browser',
  browser: 'chrome',
  browserProfile: 'Profile 1',
  importedAt: 1793203200000,
};
const missing: CookieProfileView = {
  ...douyin,
  configured: false,
  cookieCount: undefined,
};
const invoke = jest.fn();

beforeAll(() => {
  Object.defineProperty(window.crypto, 'randomUUID', {
    configurable: true,
    value: randomUUID,
  });
  i18next.addResourceBundle(
    'en',
    'download',
    require('../../../public/locales/en/download.json'),
  );
  i18next.changeLanguage('en');
});
beforeEach(() => {
  Object.defineProperty(window, 'ipc', {
    configurable: true,
    value: { platform: 'darwin', invoke },
  });
  invoke.mockReset().mockImplementation(async (channel: string) => {
    if (channel.endsWith('browserProfiles'))
      return [
        { id: 'Default', name: 'Personal', isDefault: true },
        { id: 'Profile 1', name: 'Work', isDefault: false },
      ];
    return { profiles: [douyin], cookieCount: 9, ignoredCookieCount: 12 };
  });
});

test('imports every recognized site without asking for a domain and uses the selected browser profile', async () => {
  const changed = jest.fn();
  render(
    <CookieProfilesDialog
      open
      onOpenChange={() => {}}
      onChanged={changed}
      profiles={[missing]}
    />,
  );
  const profiles = await screen.findByLabelText('Browser profile');
  await waitFor(() =>
    expect(screen.getByRole('option', { name: /Work/ })).toBeInTheDocument(),
  );
  fireEvent.change(profiles, { target: { value: 'Profile 1' } });
  fireEvent.click(
    screen.getByRole('button', { name: 'Import supported sites' }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'videoDownload:cookieProfiles:importAllFromBrowser',
      { browser: 'chrome', browserProfile: 'Profile 1' },
    ),
  );
  expect(await screen.findByRole('status')).toHaveTextContent('1 site');
  expect(screen.getByRole('status')).toHaveTextContent('Douyin');
  expect(changed).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByPlaceholderText('Domain, e.g. example.com'),
  ).not.toBeInTheDocument();
});

test('batch file cancellation leaves the current list intact without a success report', async () => {
  invoke.mockImplementation(async (channel) =>
    channel.endsWith('browserProfiles') ? [] : { cancelled: true },
  );
  const changed = jest.fn();
  render(
    <CookieProfilesDialog
      open
      onOpenChange={() => {}}
      onChanged={changed}
      profiles={[douyin]}
    />,
  );
  fireEvent.click(
    within(screen.getByRole('region', { name: 'Import cookies' })).getByRole(
      'button',
      { name: 'Import cookies.txt' },
    ),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'videoDownload:cookieProfiles:importAllFile',
      {},
    ),
  );
  expect(changed).not.toHaveBeenCalled();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

test('no matched sites produces an actionable error without marking existing cookies invalid', async () => {
  invoke.mockImplementation(async (channel) => {
    if (channel.endsWith('browserProfiles')) return [];
    throw new Error('NO_SUPPORTED_SITE_COOKIES');
  });
  render(
    <CookieProfilesDialog
      open
      onOpenChange={() => {}}
      onChanged={() => {}}
      profiles={[douyin]}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Import supported sites' }),
    ).toBeEnabled(),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Import supported sites' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'No supported-site cookies',
  );
  expect(screen.getByText(/9 cookies/)).toBeInTheDocument();
  expect(screen.queryByText('Expired')).not.toBeInTheDocument();
});

test('an import in progress disables competing imports and deletion', async () => {
  let finish: (value: unknown) => void;
  invoke.mockImplementation(async (channel) => {
    if (channel.endsWith('browserProfiles')) return [];
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  render(
    <CookieProfilesDialog
      open
      onOpenChange={() => {}}
      onChanged={() => {}}
      profiles={[douyin]}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Import supported sites' }),
    ).toBeEnabled(),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Import supported sites' }),
  );
  expect(
    within(screen.getByRole('region', { name: 'Import cookies' })).getByRole(
      'button',
      { name: 'Import cookies.txt' },
    ),
  ).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  finish!({ profiles: [douyin], cookieCount: 9, ignoredCookieCount: 0 });
  await screen.findByRole('status');
});

test('updating one site uses the browser profile selected above', async () => {
  render(
    <CookieProfilesDialog
      open
      onOpenChange={() => {}}
      onChanged={() => {}}
      profiles={[douyin]}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('option', { name: /Work/ })).toBeInTheDocument(),
  );
  fireEvent.change(screen.getByLabelText('Browser profile'), {
    target: { value: 'Profile 1' },
  });
  fireEvent.click(screen.getByText('Update this site separately'));
  fireEvent.click(screen.getByRole('button', { name: 'Import from Chrome' }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'videoDownload:cookieProfiles:importFromBrowser',
      {
        id: 'douyin',
        browser: 'chrome',
        browserProfile: 'Profile 1',
        customDef: undefined,
      },
    ),
  );
});

test('a custom site uses the same selected browser profile', async () => {
  render(
    <CookieProfilesDialog
      open
      onOpenChange={() => {}}
      onChanged={() => {}}
      profiles={[]}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('option', { name: /Work/ })).toBeInTheDocument(),
  );
  fireEvent.change(screen.getByLabelText('Browser profile'), {
    target: { value: 'Profile 1' },
  });
  fireEvent.click(screen.getByText('Manual management and other sites'));
  fireEvent.click(screen.getByRole('button', { name: 'Add custom site' }));
  fireEvent.change(screen.getByPlaceholderText('Domain, e.g. example.com'), {
    target: { value: 'example.video' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Import from Chrome' }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'videoDownload:cookieProfiles:importFromBrowser',
      expect.objectContaining({
        browser: 'chrome',
        browserProfile: 'Profile 1',
      }),
    ),
  );
});
