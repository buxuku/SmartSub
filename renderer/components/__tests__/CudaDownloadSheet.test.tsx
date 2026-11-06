import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import CudaDownloadSheet from '../settings/gpu/CudaDownloadSheet';
import type { GpuEnvironment, CudaVersion } from '../../../types/addon';
import {
  getDefaultPackageEdition,
  canDownloadLiteEdition,
} from '../settings/gpu/gpuDownloadUtils';

jest.mock('next-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function environment(toolkit: string | null): GpuEnvironment {
  return {
    platform: 'win32',
    appleSilicon: false,
    gpus: [{ name: 'RTX 4070', vendor: 'nvidia' }],
    vulkanRuntime: true,
    builtinVulkanAvailable: true,
    nvidia: {
      cudaToolkit: { installed: toolkit !== null, version: toolkit },
      gpuSupport: {
        supported: true,
        driverVersion: '610.88',
        maxCudaVersion: '13.3',
      },
      recommendation: {
        canUseCuda: true,
        recommendedVersion: '13.0.2',
        needsDlls: true,
        downloadType: 'tar.gz',
      },
    },
  };
}

function setup(
  toolkit: string | null,
  presetVersion: CudaVersion | null = null,
) {
  window.ipc = { invoke: jest.fn(async () => null) } as any;
  const onConfirmDownload = jest.fn();
  render(
    <CudaDownloadSheet
      open
      onOpenChange={() => {}}
      gpuEnv={environment(toolkit)}
      availableCudaVersions={['13.0.2', '12.4.0']}
      usedRemoteFallback={false}
      downloadSource="github"
      onDownloadSourceChange={() => {}}
      presetVersion={presetVersion}
      downloadingVariant={null}
      onConfirmDownload={onConfirmDownload}
    />,
  );
  return onConfirmDownload;
}

const confirmButton = () =>
  screen.getByRole('button', { name: /gpuAcceleration.startDownload/ });

test('Toolkit 12 不为 CUDA 13 推荐轻量包；手动选 CUDA 12 可用轻量包', () => {
  const env = environment('12.6.20');
  expect(getDefaultPackageEdition(env)).toBe('full');
  expect(canDownloadLiteEdition(env)).toBe(false);
  expect(getDefaultPackageEdition(env, '12.4.0')).toBe('lite');
  expect(canDownloadLiteEdition(env, '12.4.0')).toBe(true);
});

test('默认下载为当前 Toolkit 无法提供运行库的 CUDA 版本附带完整运行库', async () => {
  const download = setup('12.6.20');
  await waitFor(() => expect(confirmButton()).toBeEnabled());
  fireEvent.click(confirmButton());
  expect(download).toHaveBeenCalledWith('13.0.2', 'tar.gz');
});

test('更改 CUDA 版本后重新选择兼容的包类型，不能沿用上一版本的轻量选择', async () => {
  const download = setup('12.6.20', '12.4.0');
  fireEvent.click(screen.getByRole('button', { name: /CUDA 13\.0\.2/ }));
  await waitFor(() => expect(confirmButton()).toBeEnabled());
  fireEvent.click(confirmButton());
  expect(download).toHaveBeenCalledWith('13.0.2', 'tar.gz');
});

test('手动改选匹配 Toolkit 的 CUDA 版本时允许轻量下载', async () => {
  const download = setup('12.6.20');
  fireEvent.click(screen.getByRole('button', { name: 'CUDA 12.4.0' }));
  await waitFor(() => expect(confirmButton()).toBeEnabled());
  fireEvent.click(confirmButton());
  expect(download).toHaveBeenCalledWith('12.4.0', 'node.gz');
});

test('选择不兼容的轻量包时禁止开始下载', async () => {
  const download = setup('12.6.20');
  fireEvent.click(
    screen.getByRole('button', { name: /^gpuAcceleration.liteEdition / }),
  );
  await waitFor(() => expect(confirmButton()).toBeDisabled());
  fireEvent.click(confirmButton());
  expect(download).not.toHaveBeenCalled();
});
