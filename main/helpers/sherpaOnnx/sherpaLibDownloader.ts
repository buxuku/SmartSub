import fs from 'fs';
import path from 'path';
import * as https from 'https';
import * as http from 'http';
import { execFileSync } from 'child_process';
import decompress from 'decompress';
import { logMessage } from '../storeManager';
import { MirrorDownloader } from '../download/mirrorDownloader';
import { resolveReleaseBaseUrl } from '../download/sources';
import {
  getSourceFallbackOrder,
  type BinaryDownloadSource,
} from '../downloadSourceOrder';
import { calculateFileChecksum } from '../addonDownloader';
import { adhocResignDir } from '../pythonRuntime/macSign';
import { isDarwin, getExtraResourcesPath } from '../utils';
import {
  getSherpaPlatformKey,
  getSherpaStagingDir,
  getSherpaRootDir,
} from './sherpaLibPaths';
import {
  promoteStagingToCurrent,
  rollbackToPrevious,
} from './sherpaLibManager';

const SHERPA_VERSION = '1.13.2';
const SHERPA_TAG = 'sherpa-libs-latest';
/** 与 py-engine 同仓托管（GitHub / GitCode slug 不同）。 */
const SHERPA_REPO = {
  github: 'buxuku/smartsub-py-engine',
  gitcode: 'buxuku1/smartsub-py-engine',
};

function assetName(platformKey: string): string {
  return `smartsub-sherpa-onnx-${platformKey}-${SHERPA_VERSION}.tar.gz`;
}

/** 拉取小文本（.sha256），带重定向处理。 */
function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const protocol = new URL(url).protocol === 'https:' ? https : http;
    const req = protocol.get(
      url,
      { headers: { 'User-Agent': 'SmartSub-Electron' } },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          fetchText(res.headers.location).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP Error: ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

/** 校验 tar.gz 的 SHA256 与远端 .sha256 一致（远端不可用时跳过，不阻断）。 */
async function verifyChecksum(file: string, sha256Url: string): Promise<void> {
  let expected: string | null = null;
  try {
    const text = await fetchText(sha256Url);
    const m = text.trim().match(/^([a-fA-F0-9]{64})/);
    expected = m ? m[1].toLowerCase() : null;
  } catch (e) {
    logMessage(`sherpa .sha256 unavailable, skip verify: ${e}`, 'warning');
    return;
  }
  if (!expected) return;
  const actual = (await calculateFileChecksum(file)).toLowerCase();
  if (actual !== expected) {
    throw new Error(
      `sherpa checksum mismatch: expected ${expected}, got ${actual}`,
    );
  }
}

/**
 * macOS：把原生库的 @rpath 依赖改写为 @loader_path（同目录解析），再 ad-hoc 重签。
 * 现代 macOS 的 SIP 会剥离 DYLD_LIBRARY_PATH，故不能靠环境变量，必须改 install name。
 */
function resignMac(dir: string): void {
  if (!isDarwin()) return;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.node') || f.endsWith('.dylib'));
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const otool = execFileSync('otool', ['-L', full]).toString();
      for (const line of otool.split('\n')) {
        const m = line.trim().match(/^@rpath\/(\S+)\s/);
        if (m) {
          execFileSync('install_name_tool', [
            '-change',
            `@rpath/${m[1]}`,
            `@loader_path/${m[1]}`,
            full,
          ]);
        }
      }
    } catch (e) {
      logMessage(`otool/install_name_tool skipped for ${f}: ${e}`, 'warning');
    }
  }
  // install_name_tool 会使签名失效，统一 ad-hoc 重签（codesign 在 macOS 必有）。
  adhocResignDir(dir);
}

/** 在主进程用临时 env 加载 staging 的 .node 自检（require 自定义 addon + readWave 存在）。 */
function assertLoadable(dir: string): void {
  const prev = process.env.SHERPA_ONNX_LIB_DIR;
  process.env.SHERPA_ONNX_LIB_DIR = dir;
  try {
    const addonPath = path.join(
      getExtraResourcesPath(),
      'sherpa',
      'vendor',
      'addon.js',
    );
    delete require.cache[require.resolve(addonPath)];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const addon = require(addonPath);
    if (typeof addon.readWave !== 'function') {
      throw new Error('sherpa addon loaded but readWave missing');
    }
  } finally {
    if (prev === undefined) delete process.env.SHERPA_ONNX_LIB_DIR;
    else process.env.SHERPA_ONNX_LIB_DIR = prev;
  }
}

export async function downloadSherpaLib(
  preferredSource: string,
  onProgress: (percent: number) => void,
): Promise<void> {
  const platformKey = getSherpaPlatformKey();
  const tmp = path.join(getSherpaRootDir(), assetName(platformKey));
  const downloader = new MirrorDownloader((p) =>
    onProgress(Math.round(p.progress ?? 0)),
  );

  let lastErr: unknown;
  for (const source of getSourceFallbackOrder(
    preferredSource as BinaryDownloadSource,
  )) {
    try {
      const staging = getSherpaStagingDir();
      if (fs.existsSync(staging)) {
        fs.rmSync(staging, { recursive: true, force: true });
      }
      fs.mkdirSync(staging, { recursive: true });

      const base = resolveReleaseBaseUrl(source, SHERPA_REPO, SHERPA_TAG);
      const url = `${base}/${assetName(platformKey)}`;
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
      downloader.resetForDownload();
      await downloader.downloadFile(url, tmp, 0);

      await verifyChecksum(tmp, `${url}.sha256`);
      await decompress(tmp, staging);
      fs.rmSync(tmp, { force: true });

      resignMac(staging);
      assertLoadable(staging);
      promoteStagingToCurrent();
      logMessage(`sherpa lib installed from ${source}`, 'info');
      return;
    } catch (e) {
      lastErr = e;
      logMessage(`sherpa lib source ${source} failed: ${e}`, 'warning');
    }
  }
  rollbackToPrevious();
  throw new Error(`sherpa lib download failed: ${lastErr}`);
}
