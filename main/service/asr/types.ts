import type { AsrProvider } from '../../../types/asrProvider';

/** 词级时间戳（秒，原始时间轴）。 */
export interface AsrWord {
  word: string;
  start: number;
  end: number;
}

/** 段级时间戳（秒，原始时间轴）。 */
export interface AsrSegment {
  start: number;
  end: number;
  text: string;
}

/** 单个音频文件（可能是切片）的转写入参。 */
export interface AsrTranscribeInput {
  /** 已就绪的音频文件（wav/压缩后），云 service 直接上传。 */
  audioPath: string;
  /** 模型 id（如 whisper-1 / gpt-4o-transcribe）。 */
  model: string;
  /** 源语言 ISO-639-1 提示（如 en/zh）；'auto'/空表示自动检测。 */
  language?: string;
  /** 取消信号：透传给底层 HTTP 请求。 */
  signal?: AbortSignal;
}

/** 转写结果（时间轴为秒，原始时间轴）。 */
export interface AsrTranscribeResult {
  text: string;
  language?: string;
  duration?: number;
  segments?: AsrSegment[];
  words?: AsrWord[];
  /** 该模型/端点是否返回了词级时间戳（供云引擎决定走词级成句还是切片降级）。 */
  hasWordTimestamps: boolean;
}

/** ASR service 分发函数签名：按 provider.type 路由到具体实现。 */
export type AsrTranscriber = (
  provider: AsrProvider,
  input: AsrTranscribeInput,
) => Promise<AsrTranscribeResult>;
