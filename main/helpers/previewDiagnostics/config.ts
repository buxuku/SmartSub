/**
 * 视频合成预览黑屏诊断：与 Electron 无关的纯逻辑（判定、GPU 启动参数预设、开关合并）。
 *
 * 背景：Windows 上视频合成页「鼠标离开预览区进入左侧设置面板，整个视频区变黑」，
 * 3.8 没有、3.9.0 有，字幕校对页没有，Mac 复现不了。没有 Windows 开发环境时，
 * 只能发一个诊断版让用户机器上采集证据，并通过运行时开关逐个排除假设。
 *
 * 这套能力只在「诊断版」里生效：正式版没有这个可执行文件名，也没有环境变量，
 * 所有入口都会走到 isPreviewDiagnosticsEnabled() 并直接返回，行为与 3.9.0 完全一致。
 */
import path from 'path';

/** 诊断版的 productName。安装包、userData、可执行文件名都带它，和正式版并存且互不影响数据。 */
export const DIAG_PRODUCT_NAME = 'SmartSub Diagnostic';

/** 诊断版的可执行文件名关键字（electron-builder 的 productName 会成为 exe 名）。 */
const DIAG_EXE_PATTERN = /diagnostic/i;

/** 诊断数据目录名，放在 userData 下。 */
export const DIAG_DIR_NAME = 'preview-diagnostics';

/** 下次启动要应用的 GPU 预设，放在诊断数据目录里。 */
export const GPU_PRESET_FILE = 'gpu-preset.json';

/** 当前进程是不是诊断安装包：靠可执行文件名判断，不靠环境变量，用户装完就能直接用。 */
export function isDiagnosticBuild(
  execPath: string = process.execPath,
): boolean {
  return DIAG_EXE_PATTERN.test(path.basename(execPath));
}

/**
 * 诊断功能是否启用：诊断安装包，或者显式的环境变量（本地开发 / e2e 用）。
 * 正式版两者都不满足，于是整个诊断层是惰性的。
 */
export function isPreviewDiagnosticsEnabled(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): boolean {
  return env.SMARTSUB_PREVIEW_DIAG === '1' || isDiagnosticBuild(execPath);
}

/** 诊断数据目录：{userData}/preview-diagnostics。 */
export function diagnosticsDirectory(userData: string): string {
  return path.join(userData, DIAG_DIR_NAME);
}

export interface GpuPresetSwitch {
  name: string;
  value?: string;
}

export interface GpuPreset {
  id: string;
  /** 面板里显示的名字 */
  label: string;
  /** 它验证的假设，写给测试的人看 */
  detail: string;
  switches: GpuPresetSwitch[];
  /** 走 app.disableHardwareAcceleration()，等价于完全禁用 GPU */
  disableHardwareAcceleration?: boolean;
}

/**
 * 启动参数预设。每一项都对应一个具体假设，且开关在 Chromium 124（Electron 30）里真实存在：
 *  - disable-gpu-compositing：整页走软件合成，DirectComposition 视频叠加层不再参与；
 *  - DirectCompositionSoftwareOverlays：软件 overlay 路径（NVIDIA 等设备默认在用）；
 *  - DCompVisualTreeOptimization：DirectComposition 视觉树的增量更新；
 *  - use-angle=gl：绕开 D3D11 后端，换 OpenGL 后端渲染；
 *  - disable-gpu：完全禁用 GPU。
 * 注意 Chromium 124 没有「关闭 DirectComposition 视频叠加层」的命令行开关，所以这里不假装有。
 */
export const GPU_PRESETS: readonly GpuPreset[] = [
  {
    id: 'default',
    label: '默认（不加任何参数）',
    detail: '与正式版相同。',
    switches: [],
  },
  {
    id: 'no-gpu-compositing',
    label: '软件合成（--disable-gpu-compositing）',
    detail:
      '整页改用软件合成。若黑屏消失，问题在 GPU 合成 / DirectComposition 视频叠加层。',
    switches: [{ name: 'disable-gpu-compositing' }],
  },
  {
    id: 'no-sw-overlays',
    label: '关闭软件 overlay（DirectCompositionSoftwareOverlays）',
    detail: '关闭 NVIDIA 等设备默认启用的软件 overlay 路径。',
    switches: [
      { name: 'disable-features', value: 'DirectCompositionSoftwareOverlays' },
    ],
  },
  {
    id: 'no-dcomp-tree-opt',
    label: '关闭 DComp 视觉树优化（DCompVisualTreeOptimization）',
    detail: '关闭 DirectComposition 视觉树的增量更新。',
    switches: [
      { name: 'disable-features', value: 'DCompVisualTreeOptimization' },
    ],
  },
  {
    id: 'angle-gl',
    label: 'ANGLE 改用 OpenGL（--use-angle=gl）',
    detail: '绕开 D3D11 后端。若黑屏消失，问题与 D3D11 / 驱动路径有关。',
    switches: [{ name: 'use-angle', value: 'gl' }],
  },
  {
    id: 'no-gpu',
    label: '完全禁用 GPU',
    detail: '最彻底的对照：所有渲染走软件。若仍黑屏，则不是 GPU 合成问题。',
    switches: [],
    disableHardwareAcceleration: true,
  },
];

export const DEFAULT_GPU_PRESET_ID = 'default';

/** 按 id 找预设；找不到（文件损坏、旧版本留下的 id）一律回退到默认，绝不抛错。 */
export function findGpuPreset(id: unknown): GpuPreset {
  return (
    GPU_PRESETS.find((preset) => preset.id === id) ??
    (GPU_PRESETS.find(
      (preset) => preset.id === DEFAULT_GPU_PRESET_ID,
    ) as GpuPreset)
  );
}

/** 解析 gpu-preset.json 的文本。空、损坏、字段不对都返回默认预设 id。 */
export function parseGpuPresetFile(text: string | null | undefined): string {
  if (!text) return DEFAULT_GPU_PRESET_ID;
  try {
    const parsed = JSON.parse(text) as { presetId?: unknown };
    return findGpuPreset(parsed?.presetId).id;
  } catch {
    return DEFAULT_GPU_PRESET_ID;
  }
}

/** 把若干项追加进逗号分隔的列表（例如 --disable-features），去重、保序、忽略空项。 */
export function mergeCommaList(existing: string, additions: string[]): string {
  const result: string[] = [];
  for (const item of [...existing.split(','), ...additions]) {
    const trimmed = item.trim();
    if (trimmed && !result.includes(trimmed)) result.push(trimmed);
  }
  return result.join(',');
}

/** 命令行读写的最小接口（app.commandLine 满足它），让合并逻辑可以脱离 Electron 测试。 */
export interface CommandLineLike {
  getSwitchValue(name: string): string;
}

/** 这些开关的值是逗号分隔的列表，多个来源要合并而不是覆盖。 */
const LIST_SWITCHES = new Set(['disable-features', 'enable-features']);

/**
 * 计算要追加的命令行开关。同一个列表型开关（disable-features）在预设里出现多次、
 * 或者命令行上已经有值（用户手动传了参数）时，合并而不是覆盖，否则后一个会吃掉前一个。
 */
export function planSwitches(
  preset: GpuPreset,
  commandLine: CommandLineLike,
): Array<[name: string, value: string | undefined]> {
  const plan: Array<[string, string | undefined]> = [];
  const listValues = new Map<string, string[]>();
  for (const { name, value } of preset.switches) {
    if (LIST_SWITCHES.has(name) && value) {
      listValues.set(name, [...(listValues.get(name) ?? []), value]);
    } else {
      plan.push([name, value]);
    }
  }
  for (const [name, values] of listValues) {
    plan.push([name, mergeCommaList(commandLine.getSwitchValue(name), values)]);
  }
  return plan;
}

/** 命令行里我们关心的开关，快照里逐个记录值，便于确认「参数真的传进去了」。 */
export const WATCHED_SWITCHES = [
  'disable-gpu',
  'disable-gpu-compositing',
  'disable-software-rasterizer',
  'use-angle',
  'use-gl',
  'disable-features',
  'enable-features',
  'ignore-gpu-blocklist',
  'in-process-gpu',
  'user-data-dir',
] as const;
