import { fireEvent, render, screen } from '@testing-library/react';
import GpuCustomAddonSection from '../settings/gpu/GpuCustomAddonSection';

// 文案取自真实的英文文件：key 写错会在这里暴露，而不是把裸 key 展示给用户。
jest.mock('next-i18next', () => {
  const settings = require('../../public/locales/en/settings.json');
  const t = (key: string, vars: Record<string, unknown> = {}) => {
    const value = key
      .split('.')
      .reduce<any>((node, part) => node?.[part], settings);
    if (typeof value !== 'string') return `MISSING:${key}`;
    return value.replace(/\{\{(\w+)\}\}/g, (_m, name) =>
      String(vars[name] ?? ''),
    );
  };
  return { useTranslation: () => ({ t }) };
});

const STANDARD_PACKS_URL =
  'https://github.com/buxuku/whisper.cpp/releases/tag/latest';
const LEGACY_PACK_URL =
  'https://github.com/buxuku/whisper.cpp/releases/tag/legacy-cpu';

function setup(customAddonPath: string | null = null) {
  const send = jest.fn();
  window.ipc = { send } as any;
  const onSelectCustomAddon = jest.fn();
  const onClearCustomAddon = jest.fn();
  const { container } = render(
    <GpuCustomAddonSection
      customAddonPath={customAddonPath}
      onSelectCustomAddon={onSelectCustomAddon}
      onClearCustomAddon={onClearCustomAddon}
    />,
  );
  return { send, onSelectCustomAddon, onClearCustomAddon, container };
}

test('links to both release pages: the standard packs, and the legacy CPU pack for CPUs without AVX2', () => {
  const { send } = setup();

  fireEvent.click(screen.getByRole('button', { name: 'Download Packs' }));
  expect(send).toHaveBeenLastCalledWith('openUrl', STANDARD_PACKS_URL);

  fireEvent.click(screen.getByRole('button', { name: 'Legacy CPU pack' }));
  expect(send).toHaveBeenLastCalledWith('openUrl', LEGACY_PACK_URL);

  expect(send).toHaveBeenCalledTimes(2);
});

test('the tip tells people on older CPUs which link to use and that nothing needs extracting, without asking to keep any acceleration mode', () => {
  const { container } = setup();

  const tip = screen.getByText(/Older CPUs without AVX2/);
  expect(tip).toHaveTextContent('open the “Legacy CPU pack” link above');
  expect(tip).toHaveTextContent('No need to extract it');
  // 自定义加速包在所有加速模式下都优先加载，不必再提醒用户保持自动模式
  expect(tip.textContent).not.toMatch(/acceleration mode|\bAuto\b/);
  expect(container.textContent).not.toContain('MISSING:');
});

test('picking a file goes through the select handler while nothing is set', () => {
  const { onSelectCustomAddon } = setup();

  fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
  expect(onSelectCustomAddon).toHaveBeenCalledTimes(1);
});

test('an enabled custom addon shows its path and keeps both links available', () => {
  const { container } = setup('/home/me/addons/addon-linux-x64-avx.node');

  expect(screen.getByText('Custom addon enabled')).toBeInTheDocument();
  expect(
    screen.getByText('/home/me/addons/addon-linux-x64-avx.node'),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Legacy CPU pack' }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Download Packs' }),
  ).toBeInTheDocument();
  expect(container.textContent).not.toContain('MISSING:');
});
