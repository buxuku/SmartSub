/**
 * 诊断版的启动参数预设：必须在 app ready 之前执行（Chromium 的 GPU 参数只在启动时读取）。
 *
 * 面板里选了预设后，把 id 写进 {userData}/preview-diagnostics/gpu-preset.json 然后重启；
 * 这里在下一次启动的最早阶段把它翻译成命令行开关。正式版 isPreviewDiagnosticsEnabled() 为 false，
 * 整个模块什么都不做。
 *
 * 导入顺序有要求：必须在 automation/bootstrap 之后（它会设置 userData 路径），ready 之前。
 */
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import {
  DEFAULT_GPU_PRESET_ID,
  diagnosticsDirectory,
  findGpuPreset,
  GPU_PRESET_FILE,
  isPreviewDiagnosticsEnabled,
  parseGpuPresetFile,
  planSwitches,
} from './config';

let appliedPresetId = DEFAULT_GPU_PRESET_ID;

/** 本次启动实际应用的预设 id（面板据此显示「当前」）。 */
export function getAppliedGpuPresetId(): string {
  return appliedPresetId;
}

/** 读取「下次启动要用的预设」。文件缺失或损坏一律视为默认。 */
export function readPendingGpuPresetId(): string {
  try {
    return parseGpuPresetFile(
      fs.readFileSync(
        path.join(
          diagnosticsDirectory(app.getPath('userData')),
          GPU_PRESET_FILE,
        ),
        'utf8',
      ),
    );
  } catch {
    return DEFAULT_GPU_PRESET_ID;
  }
}

function applyGpuPreset(): void {
  if (!isPreviewDiagnosticsEnabled()) return;
  const preset = findGpuPreset(readPendingGpuPresetId());
  appliedPresetId = preset.id;
  for (const [name, value] of planSwitches(preset, app.commandLine)) {
    if (value === undefined) app.commandLine.appendSwitch(name);
    else app.commandLine.appendSwitch(name, value);
  }
  if (preset.disableHardwareAcceleration) app.disableHardwareAcceleration();
}

applyGpuPreset();
