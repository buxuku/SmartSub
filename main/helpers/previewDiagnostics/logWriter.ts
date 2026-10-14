/**
 * 诊断日志：一行一个 JSON（NDJSON），追加写入，串行化，超过上限就轮转成 .1。
 *
 * 渲染进程每秒成批发来事件，主进程自己也会记（快照、截图、追踪的起止）。
 * 这里只管「落盘不丢、不无限增长、任何一条坏数据都不能让写入链断掉」。
 */
import fs from 'fs';
import path from 'path';

/** 单个日志文件的上限。诊断一次的事件量远小于它，超出就轮转，只保留最近的两份。 */
export const DEFAULT_LOG_MAX_BYTES = 8 * 1024 * 1024;

/** 一批最多接收多少条、单条最多多少字符，防止渲染进程异常时把磁盘写满。 */
export const MAX_ENTRIES_PER_BATCH = 500;
export const MAX_ENTRY_CHARS = 8 * 1024;

/** 序列化一条日志。循环引用、BigInt 等不可序列化的内容降级成占位，不抛错。 */
export function serializeEntry(entry: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(entry, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
  } catch {
    text = undefined;
  }
  if (text === undefined) return JSON.stringify({ type: 'unserializable' });
  if (text.length > MAX_ENTRY_CHARS) {
    return JSON.stringify({
      type: 'truncated',
      originalType:
        entry && typeof entry === 'object' && 'type' in entry
          ? String((entry as { type?: unknown }).type)
          : undefined,
      chars: text.length,
      head: text.slice(0, 512),
    });
  }
  return text;
}

export class NdjsonLog {
  private chain: Promise<void> = Promise.resolve();
  private knownSize: number | null = null;

  constructor(
    readonly file: string,
    private readonly maxBytes: number = DEFAULT_LOG_MAX_BYTES,
  ) {}

  /** 追加若干条。返回的 Promise 永不 reject：写失败只会丢这一批，不会毒死后面的写入。 */
  append(entries: readonly unknown[]): Promise<void> {
    if (entries.length === 0) return this.chain;
    const text =
      entries
        .slice(0, MAX_ENTRIES_PER_BATCH)
        .map((entry) => serializeEntry(entry))
        .join('\n') + '\n';
    this.chain = this.chain.then(() => this.write(text)).catch(() => {});
    return this.chain;
  }

  /** 等待此前所有写入完成（导出诊断包前调用，保证文件里是最新的）。 */
  flush(): Promise<void> {
    return this.chain;
  }

  private async write(text: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    if (this.knownSize === null) {
      this.knownSize = await fs.promises
        .stat(this.file)
        .then((stat) => stat.size)
        .catch(() => 0);
    }
    const bytes = Buffer.byteLength(text);
    if (this.knownSize > 0 && this.knownSize + bytes > this.maxBytes) {
      await fs.promises
        .rename(this.file, `${this.file}.1`)
        .catch(() => fs.promises.rm(this.file, { force: true }));
      this.knownSize = 0;
    }
    await fs.promises.appendFile(this.file, text);
    this.knownSize += bytes;
  }
}
