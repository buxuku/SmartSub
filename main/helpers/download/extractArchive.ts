import { spawn } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import decompress from 'decompress';
import { logMessage } from '../storeManager';

/** 与各下载器一致的取消错误信息，便于上层用 `=== CANCELLED` 判定。 */
const CANCELLED = 'Download cancelled';

export interface ExtractArchiveOptions {
  /** 待解压的归档文件（.tar.bz2 / .tar.gz / .zip 等，system tar 自动识别压缩格式）。 */
  archivePath: string;
  /** 解压目标目录（不存在会自动创建）。 */
  destDir: string;
  /** 剥离归档内顶层目录层数（等价 tar --strip-components / decompress strip）。 */
  strip?: number;
  /** 路径包含该子串的条目跳过（如 'test_wavs'），两种后端均生效。 */
  excludeContains?: string;
  /** 安装完成后的近似总字节数，用于按「目标目录已写入大小」估算解包进度。 */
  approxTotalBytes?: number;
  /** 解包进度回调（0..1，已按 approxTotalBytes 估算并封顶 0.99）。 */
  onProgress?: (ratio: number) => void;
  /** 取消信号：触发后会 kill system tar 子进程并以 CANCELLED 抛错。 */
  signal?: AbortSignal;
}

/** 递归统计目录已写入的字节数（用于解包进度估算）。 */
async function getDirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += await getDirSize(full);
      } else if (entry.isFile()) {
        total += (await fsp.stat(full)).size;
      }
    } catch {
      // 文件解包过程中可能瞬时不可读，忽略。
    }
  }
  return total;
}

/** 轮询目标目录大小上报解包进度；返回停止函数。 */
function startProgressPoller(
  destDir: string,
  approxTotalBytes: number | undefined,
  onProgress: ((ratio: number) => void) | undefined,
): () => void {
  if (!approxTotalBytes || approxTotalBytes <= 0 || !onProgress) {
    return () => {};
  }
  let stopped = false;
  let timer: NodeJS.Timeout;
  const tick = async () => {
    if (stopped) return;
    const size = await getDirSize(destDir);
    if (stopped) return;
    onProgress(Math.min(size / approxTotalBytes, 0.99));
    timer = setTimeout(tick, 500);
  };
  timer = setTimeout(tick, 500);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/**
 * 用系统 `tar` 解包（独立 OS 进程，不阻塞 Electron 主线程事件循环）。
 * macOS/Windows 为 bsdtar(libarchive)、Linux 多为 GNU tar，`-xf` 均自动识别 bz2/gz。
 * 解析失败（无 tar / 老旧 Windows / 非零退出）时 reject，由上层回退 decompress。
 */
function extractWithSystemTar(opts: ExtractArchiveOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-xf', opts.archivePath, '-C', opts.destDir];
    if (opts.strip != null) args.push(`--strip-components=${opts.strip}`);
    if (opts.excludeContains) args.push(`--exclude=*${opts.excludeContains}*`);

    const child = spawn('tar', args, { windowsHide: true });
    let stderr = '';

    const onAbort = () => {
      child.kill();
      reject(new Error(CANCELLED));
    };
    if (opts.signal?.aborted) {
      child.kill();
      reject(new Error(CANCELLED));
      return;
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (e) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}

/** 回退：用 bundled 的 decompress（纯 JS，同步 CPU 重，会短暂阻塞主线程）。 */
async function extractWithDecompress(
  opts: ExtractArchiveOptions,
): Promise<void> {
  await decompress(opts.archivePath, opts.destDir, {
    strip: opts.strip ?? 0,
    filter: opts.excludeContains
      ? (file) => !file.path.includes(opts.excludeContains!)
      : undefined,
  });
}

/**
 * 解压归档到目标目录：优先 system tar（独立进程，主线程不卡），失败回退 decompress。
 * 解包期间按目标目录写入大小估算进度（approxTotalBytes 提供时）。
 */
export async function extractArchive(
  opts: ExtractArchiveOptions,
): Promise<void> {
  fs.mkdirSync(opts.destDir, { recursive: true });
  const stopPoller = startProgressPoller(
    opts.destDir,
    opts.approxTotalBytes,
    opts.onProgress,
  );
  try {
    try {
      await extractWithSystemTar(opts);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg === CANCELLED || opts.signal?.aborted) {
        throw new Error(CANCELLED);
      }
      logMessage(
        `system tar extract failed (${msg}); falling back to decompress`,
        'warning',
      );
      await extractWithDecompress(opts);
    }
  } finally {
    stopPoller();
  }
}
