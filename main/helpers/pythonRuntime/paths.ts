import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import type { PyEngineManifest } from '../../../types/engine';

export const PY_ENGINE_TAG = 'py-engine-v0.1.0';

export function getPyEngineRoot(): string {
  return path.join(app.getPath('userData'), 'py-engine');
}

export function getPyEngineCurrentDir(): string {
  return path.join(getPyEngineRoot(), 'current');
}

export function getPyEngineBinaryName(): string {
  return process.platform === 'win32'
    ? 'smartsub-engine.exe'
    : 'smartsub-engine';
}

export function getPyEngineBinaryPath(): string {
  return path.join(getPyEngineCurrentDir(), getPyEngineBinaryName());
}

export function getPyEngineCacheDir(): string {
  return path.join(app.getPath('userData'), 'py-engine-cache');
}

export function isPyEngineInstalled(): boolean {
  return fs.existsSync(getPyEngineBinaryPath());
}

export function readPyEngineManifest(): PyEngineManifest | null {
  const manifestPath = path.join(getPyEngineRoot(), 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(
      fs.readFileSync(manifestPath, 'utf8'),
    ) as PyEngineManifest;
  } catch {
    return null;
  }
}

export function writePyEngineManifest(manifest: PyEngineManifest): void {
  const root = getPyEngineRoot();
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
}

export function getPyEngineArtifactSuffix(): string {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
  }
  if (process.platform === 'win32') return 'windows-x64';
  if (process.platform === 'linux') return 'linux-x64';
  throw new Error(`Unsupported platform: ${process.platform}`);
}

export function getPyEngineDownloadUrl(
  source: 'github' | 'ghproxy',
  tag: string = PY_ENGINE_TAG,
): string {
  const asset = `smartsub-engine-${getPyEngineArtifactSuffix()}.tar.gz`;
  const base = `https://github.com/buxuku/SmartSub/releases/download/${tag}/${asset}`;
  if (source === 'ghproxy') {
    return `https://ghfast.top/${base}`;
  }
  return base;
}
