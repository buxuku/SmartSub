/**
 * 通过主进程解析「可复制的下载链接」（按引擎域 + 模型 + 当前选中源）。
 *
 * 链接构造逻辑集中在主进程各 catalog，renderer 仅薄封装一次 IPC，避免重复实现
 * 导致与真实下载链接漂移。解析失败（未知模型/源、IPC 异常）统一返回 null，
 * 由调用方（气泡复制按钮）给出失败提示。
 */
export type ModelUrlScope = 'funasr' | 'qwen' | 'firered' | 'pyEngine';

export async function resolveModelDownloadUrl(
  scope: ModelUrlScope,
  source: string,
  modelId?: string,
): Promise<string | null> {
  try {
    const r = await window?.ipc?.invoke('resolveModelDownloadUrl', {
      scope,
      modelId,
      source,
    });
    return r?.success && r.url ? (r.url as string) : null;
  } catch {
    return null;
  }
}
