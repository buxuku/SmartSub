import type { EngineStatus, TranscriptionEngine } from '../../types/engine';
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
  funasrVadInstalled?: boolean;
  funasrAsrModelsInstalled?: string[];
  /** faster-whisper 运行时状态（state==='ready' 即引擎包已安装可运行） */
  pythonEngineStatus?: EngineStatus;
  /** funasr 运行库（sherpa-onnx）是否已安装 */
  funasrEngineInstalled?: boolean;
  /** qwen 共享 silero VAD 是否就绪 */
  qwenVadInstalled?: boolean;
  /** qwen 已安装的模型 id 列表 */
  qwenModelsInstalled?: string[];
  /** qwen 运行库（sherpa-onnx，与 funasr 同库）是否已安装 */
  qwenEngineInstalled?: boolean;
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
  if (engine === 'funasr') {
    return info?.funasrAsrModelsInstalled ?? [];
  }
  if (engine === 'qwen') {
    return info?.qwenModelsInstalled ?? [];
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
  if (engine === 'funasr') {
    return info?.funasrAsrModelsInstalled ?? [];
  }
  if (engine === 'qwen') {
    return info?.qwenModelsInstalled ?? [];
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
  if (engine === 'funasr') {
    return (
      !!info?.funasrVadInstalled &&
      (info?.funasrAsrModelsInstalled?.length ?? 0) > 0
    );
  }
  if (engine === 'qwen') {
    return (
      !!info?.qwenVadInstalled && (info?.qwenModelsInstalled?.length ?? 0) > 0
    );
  }
  return getInstalledModelsForEngine(info, useLocalWhisper).length > 0;
}

// ── 跨引擎（逐任务选择）辅助 ─────────────────────────────────────────────
// 背景：逐任务引擎下，任务页不再"按全局引擎过滤模型"，而是把各引擎已装模型聚合成
// 「引擎 ▸ 模型」分组供选择。下面的辅助统一聚合/就绪口径，避免各处自行拼装出错。

/** 「引擎 ▸ 模型」分组：每组 = 一个引擎 + 该引擎可选模型名列表。 */
export interface EngineModelGroup {
  engine: TranscriptionEngine;
  models: string[];
}

/** (引擎,模型) 选项值的分隔符；引擎 id 与模型名均不含 "::"，故可安全编码/解码。 */
const ENGINE_MODEL_SEP = '::';

/** 把 (引擎,模型) 编码为分组下拉的选项 value。 */
export function encodeEngineModel(
  engine: TranscriptionEngine,
  model: string,
): string {
  return `${engine}${ENGINE_MODEL_SEP}${model}`;
}

/** 解析分组下拉选项 value 为 (引擎,模型)；非法返回 null。 */
export function decodeEngineModel(
  value: string | undefined,
): { engine: TranscriptionEngine; model: string } | null {
  if (!value) return null;
  const idx = value.indexOf(ENGINE_MODEL_SEP);
  if (idx <= 0) return null;
  const engine = value.slice(0, idx) as TranscriptionEngine;
  const model = value.slice(idx + ENGINE_MODEL_SEP.length);
  if (!model) return null;
  return { engine, model };
}

/** faster-whisper 运行时是否已安装可运行（引擎包 ready）。 */
function isFasterWhisperRunnable(info: EngineModelInfo | undefined): boolean {
  return info?.pythonEngineStatus?.state === 'ready';
}

/**
 * 聚合各引擎"可运行的可选模型"为分组结构（任务页「引擎 ▸ 模型」分组下拉数据源）。
 * 仅纳入「引擎运行时已安装」的引擎——只下了模型但没装对应引擎不可转写，故从任务选择中过滤掉。
 * - builtin: ggml 已装模型（内置运行时，始终可运行）
 * - fasterWhisper: ct2 已装模型，且引擎包已安装（`pythonEngineStatus.state==='ready'`）
 * - funasr: 需 VAD 就绪 + 至少一个 ASR 模型，且运行库已安装（`funasrEngineInstalled`）
 * - localCli: 用户自备模型/命令，无"已装模型"概念；仅当 `includeLocalCli` 时以
 *   内置规范模型名清单出现（保 `${whisperModel}` 占位符替换可用，D9）。
 * 空分组省略；localCli 默认不出现（由调用方按是否启用 localCli 决定）。
 */
export function getEngineModelGroups(
  info: EngineModelInfo | undefined,
  opts?: { includeLocalCli?: boolean },
): EngineModelGroup[] {
  const groups: EngineModelGroup[] = [];

  const ggml = info?.modelsInstalled ?? [];
  if (ggml.length) groups.push({ engine: 'builtin', models: ggml });

  const ct2 = info?.fasterWhisperModelsInstalled ?? [];
  if (ct2.length && isFasterWhisperRunnable(info)) {
    groups.push({ engine: 'fasterWhisper', models: ct2 });
  }

  const funasrAsr = info?.funasrAsrModelsInstalled ?? [];
  if (
    info?.funasrVadInstalled &&
    funasrAsr.length &&
    info?.funasrEngineInstalled
  ) {
    groups.push({ engine: 'funasr', models: funasrAsr });
  }

  const qwenModels = info?.qwenModelsInstalled ?? [];
  if (
    info?.qwenVadInstalled &&
    qwenModels.length &&
    info?.qwenEngineInstalled
  ) {
    groups.push({ engine: 'qwen', models: qwenModels });
  }

  if (opts?.includeLocalCli) {
    groups.push({ engine: 'localCli', models: models.map((m) => m.name) });
  }

  return groups;
}

/**
 * 跨引擎就绪判断："任意引擎装有任意可运行模型即视为就绪"。
 * 用于新手引导 / 全景概览 / 任务页"去下载模型"引导。
 * 与 getEngineModelGroups 同口径：fw/funasr 还需各自运行时已安装才算就绪；
 * localCli 不计入（自备模型，无可下载模型；其可用性由是否配置命令决定，另行处理）。
 */
export function hasAnyModelAnyEngine(
  info: EngineModelInfo | undefined,
): boolean {
  if ((info?.modelsInstalled?.length ?? 0) > 0) return true;
  if (
    (info?.fasterWhisperModelsInstalled?.length ?? 0) > 0 &&
    isFasterWhisperRunnable(info)
  ) {
    return true;
  }
  if (
    info?.funasrVadInstalled &&
    (info?.funasrAsrModelsInstalled?.length ?? 0) > 0 &&
    info?.funasrEngineInstalled
  ) {
    return true;
  }
  if (
    info?.qwenVadInstalled &&
    (info?.qwenModelsInstalled?.length ?? 0) > 0 &&
    info?.qwenEngineInstalled
  ) {
    return true;
  }
  return false;
}

/**
 * 从分组选项中挑选默认 (引擎,模型)：
 * 1) 命中"上次使用"（引擎仍有分组、模型仍可用）则沿用；模型失配时退回该引擎首个模型；
 * 2) 否则优先 builtin 分组（初次默认），无则取首个分组；
 * 3) 无任何分组返回 null（调用方据此展示"去下载模型"）。
 */
export function pickDefaultEngineModel(
  groups: EngineModelGroup[],
  last?: { engine?: TranscriptionEngine; model?: string },
): { engine: TranscriptionEngine; model: string } | null {
  if (!groups.length) return null;

  if (last?.engine) {
    const g = groups.find((x) => x.engine === last.engine);
    if (g && g.models.length) {
      const matched =
        (last.model &&
          g.models.find(
            (m) => m.toLowerCase() === last.model!.toLowerCase(),
          )) ||
        g.models[0];
      return { engine: g.engine, model: matched };
    }
  }

  const preferred = groups.find((x) => x.engine === 'builtin') ?? groups[0];
  if (preferred?.models.length) {
    return { engine: preferred.engine, model: preferred.models[0] };
  }
  return null;
}
