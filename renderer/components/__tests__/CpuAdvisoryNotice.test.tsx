import { render, screen, waitFor } from '@testing-library/react';
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

function setup(result: CpuAdvisory | null | Error) {
  const invoke = jest.fn(async (channel: string) => {
    if (channel !== 'get-cpu-advisory')
      throw new Error(`unexpected ${channel}`);
    if (result instanceof Error) throw result;
    return result;
  });
  window.ipc = { invoke } as any;
  render(<CpuAdvisoryNotice />);
  return invoke;
}

async function settled(invoke: jest.Mock) {
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('get-cpu-advisory'));
  await Promise.resolve();
  await Promise.resolve();
}

test('a CPU with everything it needs shows nothing', async () => {
  const invoke = setup(advisory());
  await settled(invoke);
  expect(screen.queryByTestId('cpu-advisory')).toBeNull();
});

test('unknown is not a warning: undetectable features never bother the user', async () => {
  const invoke = setup(
    advisory({ platform: 'win32', unknown: ['fma', 'f16c', 'bmi2'] }),
  );
  await settled(invoke);
  expect(screen.queryByTestId('cpu-advisory')).toBeNull();
});

test('arm64 (requirement not applicable) shows nothing', async () => {
  const invoke = setup(
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
  expect(screen.queryByRole('button')).toBeNull();
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
});

test('an IPC failure renders nothing instead of an error', async () => {
  const invoke = setup(new Error('no handler'));
  await settled(invoke);
  expect(screen.queryByTestId('cpu-advisory')).toBeNull();
});
