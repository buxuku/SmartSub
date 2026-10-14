import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import CpuAdvisoryNotice from '../diagnostics/CpuAdvisoryNotice';
import type { CpuAdvisory } from '../../../types/cpuAdvisory';

// 文案取自真实的英文文件：key 写错会在这里暴露，而不是把裸 key 展示给用户。
jest.mock('next-i18next', () => {
  const common = require('../../public/locales/en/common.json');
  const t = (key: string, vars: Record<string, unknown> = {}) => {
    const value = key
      .split('.')
      .reduce<any>((node, part) => node?.[part], common);
    if (typeof value !== 'string') return `MISSING:${key}`;
    return value.replace(/\{\{(\w+)\}\}/g, (_m, name) =>
      String(vars[name] ?? ''),
    );
  };
  return { useTranslation: () => ({ t }) };
});

const LEGACY_PACK_URL =
  'https://github.com/buxuku/whisper.cpp/releases/tag/legacy-cpu';

function advisory(overrides: Partial<CpuAdvisory> = {}): CpuAdvisory {
  return {
    applicable: true,
    translated: false,
    platform: 'linux',
    missing: [],
    unknown: [],
    source: 'proc-cpuinfo',
    cpuModel: 'Test CPU',
    ...overrides,
  };
}

interface SetupOptions {
  /** 当前设置的自定义加速包路径；Error = 读取失败 */
  customAddonPath?: string | null | Error;
}

function setup(result: CpuAdvisory | null | Error, options: SetupOptions = {}) {
  const state = { customAddonPath: options.customAddonPath ?? null };
  const send = jest.fn();
  const invoke = jest.fn(async (channel: string) => {
    if (channel === 'get-cpu-advisory') {
      if (result instanceof Error) throw result;
      return result;
    }
    if (channel === 'get-custom-addon-path') {
      if (state.customAddonPath instanceof Error) throw state.customAddonPath;
      return state.customAddonPath;
    }
    throw new Error(`unexpected ${channel}`);
  });
  window.ipc = { invoke, send } as any;
  render(<CpuAdvisoryNotice />);
  return { invoke, send, state };
}

async function settled(invoke: jest.Mock) {
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('get-cpu-advisory'));
  // 让所有 IPC 的 Promise 链走完，再断言“什么都没渲染”，否则断言会在渲染之前空转通过
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test('a CPU with everything it needs shows nothing', async () => {
  const { invoke } = setup(advisory());
  await settled(invoke);
  expect(screen.queryByTestId('cpu-advisory')).toBeNull();
});

test('unknown is not a warning: undetectable features never bother the user', async () => {
  const { invoke } = setup(
    advisory({ platform: 'win32', unknown: ['fma', 'f16c', 'bmi2'] }),
  );
  await settled(invoke);
  expect(screen.queryByTestId('cpu-advisory')).toBeNull();
});

test('arm64 (requirement not applicable) shows nothing', async () => {
  const { invoke } = setup(
    advisory({ applicable: false, source: 'not-applicable' }),
  );
  await settled(invoke);
  expect(screen.queryByTestId('cpu-advisory')).toBeNull();
});

test('definitely missing instruction sets are named, in upper case, and the advice is non-blocking', async () => {
  setup(advisory({ missing: ['avx2', 'fma', 'bmi2'] }));

  const box = await screen.findByTestId('cpu-advisory');
  expect(box).toHaveTextContent(
    "This computer's CPU may not support built-in speech recognition",
  );
  expect(box).toHaveTextContent(
    'needs a CPU with AVX2, FMA, BMI2, which was not detected',
  );
  expect(box).toHaveTextContent('cloud speech recognition or another engine');
  expect(box.textContent).not.toContain('MISSING:');
  // 只提醒、不拦截：唯一的控件是一个打开兼容包说明页的链接
  expect(screen.getAllByRole('button')).toHaveLength(1);
});

test('AVX present but AVX2 missing on Windows: offers the experimental Legacy CPU pack and opens its page in the system browser', async () => {
  const { send } = setup(advisory({ platform: 'win32', missing: ['avx2'] }));

  const box = await screen.findByTestId('cpu-advisory');
  // 原有的建议保留，兼容包是额外的一条出路
  expect(box).toHaveTextContent('cloud speech recognition or another engine');
  expect(box).toHaveTextContent('experimental');
  expect(box).toHaveTextContent('Legacy CPU pack');
  // 路径要和界面上的真实标签一致；自定义加速包在所有加速模式下都优先加载，
  // 不需要（也不应该）再叮嘱用户把模式保持在自动
  expect(box).toHaveTextContent(
    'Engines → whisper.cpp (built-in) → GPU acceleration · Manage / Advanced → Custom Addon',
  );
  expect(box.textContent).not.toMatch(/acceleration mode|\bAuto\b/);
  expect(box.textContent).not.toContain('MISSING:');

  expect(send).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Download and import guide' }),
  );
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith('openUrl', LEGACY_PACK_URL);
});

test('a CPU without AVX gets no pack link: the pack cannot run there, so only the original advice stays', async () => {
  setup(advisory({ platform: 'win32', missing: ['avx', 'avx2'] }));

  const box = await screen.findByTestId('cpu-advisory');
  expect(box).toHaveTextContent('cloud speech recognition or another engine');
  expect(box.textContent).not.toContain('Legacy CPU pack');
  expect(screen.queryByRole('button')).toBeNull();
});

test('macOS has no pack: an Intel Mac without AVX2 gets no link', async () => {
  setup(advisory({ platform: 'darwin', missing: ['avx2'] }));

  const box = await screen.findByTestId('cpu-advisory');
  expect(box).toHaveTextContent('cloud speech recognition or another engine');
  expect(box.textContent).not.toContain('Legacy CPU pack');
  expect(screen.queryByRole('button')).toBeNull();
});

test('with a custom addon already enabled, the notice stops asking for a download and says what to check', async () => {
  setup(advisory({ platform: 'linux', missing: ['avx2', 'fma'] }), {
    customAddonPath: '/home/me/addons/addon-linux-x64-avx.node',
  });

  const box = await screen.findByTestId('cpu-advisory');
  expect(box).toHaveTextContent('A custom addon is enabled');
  expect(box).toHaveTextContent(
    'missing AVX2, FMA, which the built-in acceleration packs need',
  );
  expect(box).toHaveTextContent('file name contains “-avx”');
  expect(box).toHaveTextContent('clear the custom addon');
  // 不再催用户去下载，也不再说“继续使用可能闪退”
  expect(box.textContent).not.toContain('Download and import guide');
  expect(box.textContent).not.toContain('may crash the app');
  expect(box.textContent).not.toContain('MISSING:');
  expect(screen.queryByRole('button')).toBeNull();
});

test('a custom addon does not change the advice for a CPU the pack cannot help', async () => {
  setup(advisory({ platform: 'win32', missing: ['avx', 'avx2'] }), {
    customAddonPath: 'C:\\addons\\addon.node',
  });

  const box = await screen.findByTestId('cpu-advisory');
  expect(box).toHaveTextContent(
    "This computer's CPU may not support built-in speech recognition",
  );
  expect(box.textContent).not.toContain('A custom addon is enabled');
});

test('a failing custom addon lookup counts as "none set": the pack link is still offered', async () => {
  setup(advisory({ platform: 'linux', missing: ['avx2'] }), {
    customAddonPath: new Error('no handler'),
  });

  await screen.findByRole('button', { name: 'Download and import guide' });
});

test('importing or clearing a custom addon while the notice is on screen updates it', async () => {
  const { state } = setup(advisory({ platform: 'linux', missing: ['avx2'] }));
  await screen.findByRole('button', { name: 'Download and import guide' });

  // 用户在旁边的“自定义加速包”里选好文件：GPU 卡片会广播 gpu-settings-changed
  state.customAddonPath = '/home/me/addons/addon-linux-x64-avx.node';
  act(() => {
    window.dispatchEvent(new Event('gpu-settings-changed'));
  });
  await screen.findByText('A custom addon is enabled');
  expect(screen.queryByRole('button')).toBeNull();

  // 清除之后恢复成“去下载”的提示
  state.customAddonPath = null;
  act(() => {
    window.dispatchEvent(new Event('gpu-settings-changed'));
  });
  await screen.findByRole('button', { name: 'Download and import guide' });
  expect(screen.queryByText('A custom addon is enabled')).toBeNull();
});

test('Rosetta on macOS recommends the arm64 build', async () => {
  setup(
    advisory({ platform: 'darwin', translated: true, source: 'translated' }),
  );

  const box = await screen.findByTestId('cpu-advisory');
  expect(box).toHaveTextContent('Running under translation');
  expect(box).toHaveTextContent('through Rosetta on Apple silicon');
  expect(box).toHaveTextContent('Apple silicon (arm64) build');
  // 转译环境下探测值不可信，不会有“缺失指令集”的说法
  expect(box.textContent).not.toContain('was not detected');
});

test('x64 translation on other platforms does not mention Rosetta and offers no arm64 build', async () => {
  setup(
    advisory({ platform: 'win32', translated: true, source: 'translated' }),
  );

  const box = await screen.findByTestId('cpu-advisory');
  expect(box).toHaveTextContent('running through translation on an ARM device');
  expect(box.textContent).not.toContain('Rosetta');
  expect(box.textContent).not.toContain('arm64');
  // 转译环境没有对应的兼容包
  expect(screen.queryByRole('button')).toBeNull();
});

test('an IPC failure renders nothing instead of an error', async () => {
  const { invoke } = setup(new Error('no handler'));
  await settled(invoke);
  expect(screen.queryByTestId('cpu-advisory')).toBeNull();
});
