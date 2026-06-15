import type { TranscriptionEngine } from '../../types/engine';
import { models } from './utils';

/**
 * 引擎感知的模型就绪判断。
 *
 * 背景：`systemInfo.modelsInstalled` 是 whisper.cpp(ggml) 单引擎时代的字段，
 * 仅代表 ggml 模型；新增 faster-whisper 引擎后其模型在
 * `fasterWhisperModelsInstalled`（独立命名空间）。两个字段语义不同需并存，
 * 因此「当前引擎是否已就绪 / 已装哪些模型」必须按当前引擎判断，统一收敛到这里，
 * 避免各处各自只看 `modelsInstalled` 而误判（已下 faster-whisper 模型仍提示无模型）。
 */
export interface EngineModelInfo {
  transcriptionEngine?: TranscriptionEngine;
  modelsInstalled?: string[];
  fasterWhisperModelsInstalled?: string[];
}

/** 解析当前转写引擎，兼容旧的 useLocalWhisper 开关 */
export function resolveEngine(
  info: EngineModelInfo | undefined,
  useLocalWhisper = false,
): TranscriptionEngine {
  return (
    info?.transcriptionEngine ?? (useLocalWhisper ? 'localCli' : 'builtin')
  );
}

/**
 * 当前引擎已安装的模型列表。
 * localCli 由用户自备模型/命令，这里不枚举，返回空数组（就绪与否由 hasModelsForEngine 判定）。
 */
export function getInstalledModelsForEngine(
  info: EngineModelInfo | undefined,
  useLocalWhisper = false,
): string[] {
  const engine = resolveEngine(info, useLocalWhisper);
  if (engine === 'fasterWhisper') {
    return info?.fasterWhisperModelsInstalled ?? [];
  }
  if (engine === 'localCli') {
    return [];
  }
  return info?.modelsInstalled ?? [];
}

/**
 * 当前引擎在「语音模型」下拉里可选的模型列表（与 Models.tsx 下拉同源）。
 * 与 getInstalledModelsForEngine 的区别：localCli 返回内置 models 名单（用户自备模型/命令，
 * 下拉里仍可选），而 getInstalledModelsForEngine 对 localCli 返回 [] 用于「就绪判断」。
 * 用于默认模型自动选择，确保自动选中的值一定是下拉里存在的选项。
 */
export function getSelectableModelsForEngine(
  info: EngineModelInfo | undefined,
  useLocalWhisper = false,
): string[] {
  const engine = resolveEngine(info, useLocalWhisper);
  if (engine === 'fasterWhisper') {
    return info?.fasterWhisperModelsInstalled ?? [];
  }
  if (engine === 'localCli') {
    return models.map((m) => m.name);
  }
  return info?.modelsInstalled ?? [];
}

/** 当前引擎是否已就绪可开始转写 */
export function hasModelsForEngine(
  info: EngineModelInfo | undefined,
  useLocalWhisper = false,
): boolean {
  const engine = resolveEngine(info, useLocalWhisper);
  if (engine === 'localCli') return true;
  return getInstalledModelsForEngine(info, useLocalWhisper).length > 0;
}
