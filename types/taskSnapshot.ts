/**
 * 会把任务页切换为只读快照、并在重试时固定复用的配置。
 *
 * 普通字幕任务仍沿用可编辑的全局配置；一旦启用角色分离、强制忽略内封字幕，
 * 它和带配音/合成的流水线任务一样需要固定创建时配置；参考文稿作为一次性任务输入也必须固定。
 */
export interface PinnableTaskConfigSnapshot {
  [key: string]: unknown;
  dub?: unknown;
  compose?: unknown;
  speakerDiarization?: unknown;
  manuscriptPath?: unknown;
  useEmbeddedSubtitles?: unknown;
}

export function isPinnedTaskConfigSnapshot(
  snapshot: PinnableTaskConfigSnapshot | null | undefined,
): boolean {
  const manuscriptPath =
    typeof snapshot?.manuscriptPath === 'string'
      ? snapshot.manuscriptPath.trim()
      : '';
  return Boolean(
    snapshot &&
      (snapshot.dub ||
        snapshot.compose ||
        snapshot.speakerDiarization === true ||
        snapshot.useEmbeddedSubtitles === false ||
        manuscriptPath),
  );
}

/** 只读快照可能携带全局表单残留；任务类型不含翻译时不得展示这些字段。 */
export function isTaskSnapshotTranslationEnabled(
  snapshot: { translateProvider?: unknown } | null | undefined,
  taskHasTranslate: boolean,
): boolean {
  return Boolean(
    taskHasTranslate &&
      snapshot?.translateProvider &&
      snapshot.translateProvider !== '-1',
  );
}
