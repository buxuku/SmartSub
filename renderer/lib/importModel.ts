/**
 * 渲染层「从本地文件夹导入模型」的统一调用封装。
 * 负责调用主进程 importModel IPC 并把结果归一化为 ImportOutcome，
 * 文案/刷新由各引擎面板按自身 i18n 命名空间处理（避免传 t 引发的类型耦合）。
 */
export type ImportOutcome =
  | { kind: 'success' }
  | { kind: 'canceled' }
  | { kind: 'invalid-layout'; missing: string[] }
  | { kind: 'error'; message: string };

export async function importModelFromFolder(
  engine: 'funasr' | 'qwen' | 'fireRedAsr' | 'fasterWhisper',
  modelId: string,
): Promise<ImportOutcome> {
  try {
    const r = await window?.ipc?.invoke('importModel', { engine, modelId });
    if (r?.success) return { kind: 'success' };
    if (r?.canceled) return { kind: 'canceled' };
    if (r?.reason === 'invalid-layout') {
      return { kind: 'invalid-layout', missing: r.missing || [] };
    }
    return { kind: 'error', message: r?.error || r?.reason || 'unknown' };
  } catch (e) {
    return { kind: 'error', message: String(e) };
  }
}
