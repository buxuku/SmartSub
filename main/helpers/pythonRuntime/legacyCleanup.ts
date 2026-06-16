import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { logMessage } from '../storeManager';

/**
 * 清理三层架构改造前（PyInstaller / 早期可重定位版本）遗留的目录与状态文件。
 *
 * 当前架构使用：
 *   - userData/py-base/current        （Layer 1 基座，可升级覆盖）
 *   - userData/py-engines/<engineId>  （Layer 2 引擎包，复数目录）
 *   - userData/py-engine-download-state-<engineId>.json （按引擎隔离的下载状态）
 *
 * 以下为已彻底废弃、可安全删除的遗留物（仅在本机历史版本残留）：
 *   - userData/py-engine               （单数：旧 PyInstaller 单二进制引擎目录）
 *   - userData/py-engine-download-state.json （旧单引擎下载状态，无 engineId 后缀）
 *
 * 不在清理范围（仍被现网代码使用，误删会丢数据）：
 *   - userData/py-engine-cache         （faster-whisper 旧 HF 缓存，按模型在 UI 内清理）
 *   - userData/py-engines              （复数：当前引擎包根目录）
 *
 * 幂等：仅当目标存在时删除并记日志；缺省静默。任何异常都吞掉，不影响启动。
 */
export function cleanupLegacyPyEngine(): void {
  const userData = app.getPath('userData');

  const legacyTargets: { path: string; kind: 'dir' | 'file' }[] = [
    { path: path.join(userData, 'py-engine'), kind: 'dir' },
    {
      path: path.join(userData, 'py-engine-download-state.json'),
      kind: 'file',
    },
  ];

  for (const target of legacyTargets) {
    try {
      if (!fs.existsSync(target.path)) continue;
      fs.rmSync(target.path, {
        recursive: target.kind === 'dir',
        force: true,
      });
      logMessage(`Removed legacy py-engine artifact: ${target.path}`, 'info');
    } catch (error) {
      // 占用 / 权限等问题不应阻断启动，下次启动会再尝试
      logMessage(
        `Failed to remove legacy py-engine artifact ${target.path}: ${error}`,
        'warning',
      );
    }
  }
}
