/**
 * 会把任务页切换为只读快照、并在重试时固定复用的配置。
 *
 * 普通字幕任务仍沿用可编辑的全局配置；一旦启用说话者分离，它和带配音/合成的
 * 流水线任务一样需要固定创建时配置，避免同一任务重试得到不同的说话者标签。
 */
export interface PinnableTaskConfigSnapshot {
  [key: string]: unknown;
  dub?: unknown;
  compose?: unknown;
  speakerDiarization?: unknown;
}

export function isPinnedTaskConfigSnapshot(
  snapshot: PinnableTaskConfigSnapshot | null | undefined,
): boolean {
  return Boolean(
    snapshot &&
      (snapshot.dub ||
        snapshot.compose ||
        snapshot.speakerDiarization === true),
  );
}
