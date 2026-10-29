import React from 'react';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import i18next from 'i18next';
import CookieProfilesDialog from '../CookieProfilesDialog';
import type { CookieProfileView } from '../../../../types/download';

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
  expect(
    within(screen.getByRole('table')).getByText('Douyin'),
  ).toBeInTheDocument();
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
  expect(
    screen.getByRole('button', { name: 'Clear Douyin cookies' }),
  ).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Clear all' })).toBeDisabled();
  finish!({ profiles: [douyin], cookieCount: 9, ignoredCookieCount: 0 });
  await screen.findByRole('status');
});

test('shows only imported sites in compact rows with expiry and a clear action', async () => {
  const knownExpiry = {
    ...douyin,
    id: 'youtube',
    name: 'cookie.presetYoutube',
    expiresAt: 1800000000,
  };
  const expired = {
    ...douyin,
    id: 'bilibili',
    name: 'cookie.presetBilibili',
    expired: true,
  };
  render(
    <CookieProfilesDialog
      open
      onOpenChange={() => {}}
      onChanged={() => {}}
      profiles={[
        douyin,
        knownExpiry,
        expired,
        { ...missing, id: 'vimeo', name: 'cookie.presetVimeo' },
      ]}
    />,
  );
  const table = screen.getByRole('table');
  const rows = within(table).getAllByRole('row');
  expect(rows).toHaveLength(4);
  expect(within(rows[1]).getAllByRole('cell')).toHaveLength(3);
  expect(within(rows[1]).getByText('Unknown')).toBeInTheDocument();
  expect(
    within(rows[2]).getByText(new Date(1800000000 * 1000).toLocaleDateString()),
  ).toBeInTheDocument();
  expect(within(rows[3]).getByText('Expired')).toBeInTheDocument();
  expect(within(table).queryByText('Vimeo')).not.toBeInTheDocument();
  expect(table).not.toHaveTextContent(/chrome|douyin\.com|9 cookies|Profile 1/);
  expect(
    screen.queryByText('Update this site separately'),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText('Manual management and other sites'),
  ).not.toBeInTheDocument();
  expect(screen.queryByText('Add custom site')).not.toBeInTheDocument();
  expect(screen.queryByText('Paste cookies')).not.toBeInTheDocument();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Import supported sites' }),
    ).toBeEnabled(),
  );
});

test('clears a single site and requests the updated list', async () => {
  const changed = jest.fn();
  render(
    <CookieProfilesDialog
      open
      onOpenChange={() => {}}
      onChanged={changed}
      profiles={[douyin]}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Clear Douyin cookies' }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('videoDownload:cookieProfiles:delete', {
      id: 'douyin',
    }),
  );
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
});

test('clears all sites through the bulk endpoint and refreshes the list', async () => {
  const changed = jest.fn();
  render(
    <CookieProfilesDialog
      open
      onOpenChange={() => {}}
      onChanged={changed}
      profiles={[douyin]}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'videoDownload:cookieProfiles:clearAll',
    ),
  );
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
});

test('a failed clear reports the failure and re-enables actions', async () => {
  invoke.mockImplementation(async (channel) => {
    if (channel.endsWith('browserProfiles')) return [];
    throw new Error('permission denied');
  });
  render(
    <CookieProfilesDialog
      open
      onOpenChange={() => {}}
      onChanged={() => {}}
      profiles={[douyin]}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Could not clear cookies',
  );
  expect(screen.getByRole('button', { name: 'Clear all' })).toBeEnabled();
});

test('the empty state has no per-site actions and disables clearing all', async () => {
  render(
    <CookieProfilesDialog
      open
      onOpenChange={() => {}}
      onChanged={() => {}}
      profiles={[missing]}
    />,
  );
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Clear all' })).toBeDisabled();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Import supported sites' }),
    ).toBeEnabled(),
  );
});
