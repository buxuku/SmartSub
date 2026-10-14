/**
 * Chromium 内部追踪（contentTracing）：录几秒，落成 .json.gz，可以用 chrome://tracing 或 Perfetto 打开。
 *
 * 只录和「视频叠加层 / 合成 / 呈现」有关的类别，所以文件不大（几秒通常是几 MB）：
 *  - gpu：DirectComposition 的提交（DCLayerTree::CommitAndClearPendingOverlays）、
 *    交换链（SwapChainPresenter::*）、PresentDCOMPSurface 等；
 *  - viz：合成器的 Display::DrawAndSwap、OverlayProcessorWin::ProcessForOverlays（叠加层决策）；
 *  - benchmark / display.framedisplayed：每一帧是否真的被呈现；
 *  - blink.user_timing：渲染进程里 performance.mark 打的标记（鼠标进入/离开哪个区域），用来和上面对时间。
 */
import { contentTracing } from 'electron';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import zlib from 'zlib';

export const TRACE_CATEGORIES = [
  'gpu',
  'viz',
  'benchmark',
  'blink.user_timing',
  'disabled-by-default-gpu.service',
  'disabled-by-default-display.framedisplayed',
] as const;

/** traces/ 里最多保留几份，超出删最旧的。 */
export const MAX_TRACE_FILES = 3;

let active = false;

export function isTraceActive(): boolean {
  return active;
}

export async function startTrace(): Promise<void> {
  if (active) throw new Error('a trace is already running');
  await contentTracing.startRecording({
    included_categories: [...TRACE_CATEGORIES],
    excluded_categories: [],
  });
  active = true;
}

export async function stopTrace(
  dir: string,
  name: string,
): Promise<{ file: string; bytes: number; rawBytes: number }> {
  if (!active) throw new Error('no trace is running');
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const raw = path.join(dir, `${name}.json`);
    const written = await contentTracing.stopRecording(raw);
    const gz = `${written}.gz`;
    await pipeline(
      fs.createReadStream(written),
      zlib.createGzip({ level: 6 }),
      fs.createWriteStream(gz),
    );
    const rawBytes = (await fs.promises.stat(written)).size;
    await fs.promises.rm(written, { force: true });
    void trimTraceFiles(dir);
    return {
      file: path.basename(gz),
      bytes: (await fs.promises.stat(gz)).size,
      rawBytes,
    };
  } finally {
    active = false;
  }
}

async function trimTraceFiles(dir: string): Promise<void> {
  try {
    const names = (await fs.promises.readdir(dir)).filter((n) =>
      n.endsWith('.json.gz'),
    );
    if (names.length <= MAX_TRACE_FILES) return;
    const stats = await Promise.all(
      names.map(async (name) => ({
        name,
        mtime: (await fs.promises.stat(path.join(dir, name))).mtimeMs,
      })),
    );
    stats.sort((a, b) => a.mtime - b.mtime);
    for (const { name } of stats.slice(0, stats.length - MAX_TRACE_FILES)) {
      await fs.promises.rm(path.join(dir, name), { force: true });
    }
  } catch {
    // 清理失败不影响诊断本身
  }
}
