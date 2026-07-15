/**
 * 人工检查点（闸门）纯判定逻辑：零依赖，供 fileProcessor / releaseGate IPC
 * 与单测共用。停靠与放行的状态机：'' → review →（放行）→ passed。
 */

export type GateKind = 'subtitle' | 'dubbing';

export const GATE_FIELD: Record<GateKind, 'subtitleGate' | 'dubbingGate'> = {
  subtitle: 'subtitleGate',
  dubbing: 'dubbingGate',
};

interface GateFormData {
  gates?: { subtitle?: 'manual' | 'auto'; dubbing?: 'manual' | 'auto' };
  dub?: unknown;
  compose?: unknown;
}

interface GateFile {
  uuid?: string;
  subtitleGate?: string;
  dubbingGate?: string;
}

/**
 * 字幕校对检查点：manual 且存在下游成本阶段（配音/合成）且尚未放行。
 * 无下游阶段时校对没有"把关"对象，不停靠。
 */
export function shouldDockAtSubtitleGate(
  formData: GateFormData | undefined,
  file: GateFile,
): boolean {
  return (
    formData?.gates?.subtitle === 'manual' &&
    Boolean(formData?.dub || formData?.compose) &&
    file?.subtitleGate !== 'passed'
  );
}

/** 配音确认检查点：任务含配音、manual 且尚未放行。 */
export function shouldDockAtDubbingGate(
  formData: GateFormData | undefined,
  file: GateFile,
): boolean {
  return (
    Boolean(formData?.dub) &&
    formData?.gates?.dubbing === 'manual' &&
    file?.dubbingGate !== 'passed'
  );
}

/**
 * 放行目标过滤：仅处于 review 的文件可放行（并发保护——重复请求/已放行的
 * 文件被自然排除），可选按 uuid 圈定子集。
 */
export function filterReleasableFiles<T extends GateFile>(
  files: T[],
  gate: GateKind,
  fileUuids?: string[],
): T[] {
  const field = GATE_FIELD[gate];
  const allow = fileUuids?.length ? new Set(fileUuids) : null;
  return files.filter(
    (file) =>
      file?.[field] === 'review' && (!allow || allow.has(file.uuid ?? '')),
  );
}

/** 统计各检查点待校对数（聚合操作条/通知用） */
export function countReviewFiles(files: GateFile[]): {
  subtitle: number;
  dubbing: number;
} {
  let subtitle = 0;
  let dubbing = 0;
  for (const file of files) {
    if (file?.subtitleGate === 'review') subtitle += 1;
    if (file?.dubbingGate === 'review') dubbing += 1;
  }
  return { subtitle, dubbing };
}
