import { ipcMain } from '../automation/handlers';
import { logMessage } from './logger';
import { probeEmbeddedSubtitles } from './embeddedSubtitleProbe';
import {
  normalizeScanFilePaths,
  scanForEmbeddedSubtitles,
} from './embeddedSubtitleScan';
import {
  EMBEDDED_SCAN_BUDGET_MS,
  type EmbeddedSubtitleScanResult,
} from '../../types/embeddedSubtitle';

/**
 * 开始任务前的内封字幕探测（仅界面使用，不在自动化目录里）。
 * 永不抛错：任何异常都当作「没有结果」，由渲染进程按「不询问」处理。
 */
export function setupEmbeddedSubtitleHandlers(): void {
  ipcMain.handle(
    'findEmbeddedSubtitles',
    async (_event, payload): Promise<EmbeddedSubtitleScanResult> => {
      try {
        const filePaths = normalizeScanFilePaths(payload);
        const result = await scanForEmbeddedSubtitles(filePaths, {
          // 单个文件的超时与整体预算一致：整体到点本来就会中止它
          probe: (filePath, signal) =>
            probeEmbeddedSubtitles(filePath, EMBEDDED_SCAN_BUDGET_MS, signal),
        });
        if (result.candidates > 0) {
          logMessage(
            `embedded subtitle pre-start scan: ${result.status}, checked ${result.checked}/${result.candidates} in ${result.elapsedMs} ms`,
            'info',
          );
        }
        return result;
      } catch (error) {
        logMessage(
          `embedded subtitle pre-start scan failed: ${error}`,
          'warning',
        );
        return { status: 'unknown', checked: 0, candidates: 0, elapsedMs: 0 };
      }
    },
  );
}
