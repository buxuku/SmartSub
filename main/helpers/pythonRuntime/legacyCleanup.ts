import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { logMessage } from '../storeManager';
import { getEngineDir, getRuntimePythonPath } from './paths';

/**
 * 清理历史架构遗留的 userData 目录与状态文件（自包含运行时 + 内置 sherpa 改造前的产物）。
 *
 * 当前架构使用：
 *   - userData/py-engines/<engineId>  （faster-whisper 单自包含运行时，含内嵌解释器）
 *   - userData/py-engine-download-state-<engineId>.json （按引擎隔离的下载状态）
 *   - sherpa-onnx 原生库随安装包内置（extraResources/sherpa/native/<platformKey>/），不落 userData
 *
 * 以下为已彻底废弃、可安全删除的遗留物（仅在本机历史版本残留）：
 *   - userData/py-engine               （单数：旧 PyInstaller 单二进制引擎目录）
 *   - userData/py-engine-download-state.json （旧单引擎下载状态，无 engineId 后缀）
 *   - userData/py-base                 （可下载/可升级 Python 基座；基座已并入运行时包）
 *   - userData/sherpa-onnx             （sherpa 运行时下载树 current/staging/previous；现改内置）
 *   - userData/py-engines/<engineId>   （旧「基座+引擎」分体包：有 main.py/site-packages 但缺内嵌解释器，
 *                                        在新方案下不可用，删除以引导重下单运行时）
 *
 * 不在清理范围（仍被现网代码使用，误删会丢数据）：
 *   - userData/py-engine-cache         （faster-whisper 旧 HF 缓存，按模型在 UI 内清理）
 *   - userData/py-engines              （复数：当前运行时根目录）
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
    // 基座已并入运行时包：整个下载/升级基座目录退役。
    { path: path.join(userData, 'py-base'), kind: 'dir' },
    // sherpa-onnx 改为随安装包内置：旧运行时下载树退役。
    { path: path.join(userData, 'sherpa-onnx'), kind: 'dir' },
  ];

  // 旧「基座+引擎」分体安装：仅当运行时目录存在但缺内嵌解释器时清除（避免误删新版自包含运行时）。
  const fwRuntimeDir = getEngineDir('faster-whisper');
  if (
    fs.existsSync(fwRuntimeDir) &&
    !fs.existsSync(getRuntimePythonPath(fwRuntimeDir))
  ) {
    legacyTargets.push({ path: fwRuntimeDir, kind: 'dir' });
  }

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
