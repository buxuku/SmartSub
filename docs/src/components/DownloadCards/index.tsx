import React from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

const GITHUB_RELEASE_BASE =
  'https://github.com/buxuku/SmartSub/releases/download';

interface DownloadCardProps {
  title: string;
  description: string;
  downloadUrl: string;
  buttonText: string;
}

function DownloadCard({
  title,
  description,
  downloadUrl,
  buttonText,
}: DownloadCardProps) {
  return (
    <div className="col col--6" style={{ marginBottom: '1rem' }}>
      <div className="card">
        <div className="card__header">
          <h3>{title}</h3>
        </div>
        <div className="card__body">
          <p>{description}</p>
        </div>
        <div className="card__footer">
          <a
            href={downloadUrl}
            className="button button--primary button--block"
          >
            {buttonText}
          </a>
        </div>
      </div>
    </div>
  );
}

export default function DownloadCards(): JSX.Element {
  const { siteConfig } = useDocusaurusContext();
  const version = siteConfig.customFields?.appVersion as string;

  // Generate download URLs
  const getWindowsUrl = (cudaVersion: string, cudaOpt: string) =>
    `${GITHUB_RELEASE_BASE}/v${version}/SmartSub_Windows_${version}_x64_${cudaVersion}_${cudaOpt}.exe`;

  const getMacUrl = (arch: string) =>
    `${GITHUB_RELEASE_BASE}/v${version}/SmartSub_Mac_${version}_${arch}.dmg`;

  const getLinuxUrl = (
    cudaVersion: string,
    cudaOpt: string,
    ext: string = 'AppImage',
  ) =>
    `${GITHUB_RELEASE_BASE}/v${version}/SmartSub_Linux_${version}_x64_${cudaVersion}_${cudaOpt}.${ext}`;

  return (
    <div
      className="download-section"
      style={{ marginTop: '40px', marginBottom: '40px' }}
    >
      <Tabs groupId="os-choice" queryString="os">
        <TabItem value="windows" label="Windows" default>
          <div className="row" style={{ marginBottom: '1rem' }}>
            <DownloadCard
              title="Windows (NVIDIA CUDA 13.0.2+)"
              description="适用于 Windows x64 系统，需 NVIDIA 显卡及 CUDA Toolkit 13.0.2 或更高版本。"
              downloadUrl={getWindowsUrl('13.0.2', 'optimized')}
              buttonText="下载 (EXE)"
            />
            <DownloadCard
              title="Windows (NVIDIA CUDA 12.4.0+)"
              description="适用于 Windows x64 系统，需 NVIDIA 显卡及 CUDA Toolkit 12.4.0 或更高版本。"
              downloadUrl={getWindowsUrl('12.4.0', 'optimized')}
              buttonText="下载 (EXE)"
            />
          </div>
          <div className="row" style={{ marginBottom: '1rem' }}>
            <DownloadCard
              title="Windows (NVIDIA CUDA 12.2.0+)"
              description="适用于 Windows x64 系统，需 NVIDIA 显卡及 CUDA Toolkit 12.2.0 或更高版本。"
              downloadUrl={getWindowsUrl('12.2.0', 'optimized')}
              buttonText="下载 (EXE)"
            />
            <DownloadCard
              title="Windows (NVIDIA CUDA 11.8.0)"
              description="适用于 Windows x64 系统，需 NVIDIA 显卡及 CUDA Toolkit 11.8.0 版本。"
              downloadUrl={getWindowsUrl('11.8.0', 'optimized')}
              buttonText="下载 (EXE)"
            />
          </div>
          <div className="row">
            <DownloadCard
              title="Windows (无 CUDA)"
              description="适用于 Windows x64 系统。如果您没有 NVIDIA 显卡，或不确定 CUDA 版本，请选择此版本。"
              downloadUrl={getWindowsUrl('no-cuda', 'generic')}
              buttonText="下载 (EXE)"
            />
          </div>
        </TabItem>

        <TabItem value="macos" label="macOS">
          <div className="row">
            <DownloadCard
              title="Mac (Apple Silicon)"
              description="适用于配备 Apple Silicon (M系列) 芯片的 Mac。"
              downloadUrl={getMacUrl('arm64')}
              buttonText="下载 (DMG)"
            />
            <DownloadCard
              title="Mac (Intel)"
              description="适用于配备 Intel 处理器的 Mac。"
              downloadUrl={getMacUrl('x64')}
              buttonText="下载 (DMG)"
            />
          </div>
        </TabItem>

        <TabItem value="linux" label="Linux">
          <div className="row" style={{ marginBottom: '1rem' }}>
            <DownloadCard
              title="Linux (NVIDIA CUDA 13.0.2+)"
              description="适用于 Linux x64 系统，需 NVIDIA 显卡及 CUDA Toolkit 13.0.2 或更高版本。"
              downloadUrl={getLinuxUrl('13.0.2', 'optimized')}
              buttonText="下载 (AppImage)"
            />
            <DownloadCard
              title="Linux (NVIDIA CUDA 12.4.0+)"
              description="适用于 Linux x64 系统，需 NVIDIA 显卡及 CUDA Toolkit 12.4.0 或更高版本。"
              downloadUrl={getLinuxUrl('12.4.0', 'optimized')}
              buttonText="下载 (AppImage)"
            />
          </div>
          <div className="row">
            <DownloadCard
              title="Linux (无 CUDA)"
              description="适用于 Linux x64 系统。如果您没有 NVIDIA 显卡，或不确定 CUDA 版本，请选择此版本。"
              downloadUrl={getLinuxUrl('no-cuda', 'generic')}
              buttonText="下载 (AppImage)"
            />
          </div>
        </TabItem>
      </Tabs>
    </div>
  );
}
