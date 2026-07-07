import type {
  TtsProvider,
  TtsSegmentRequest,
} from '../../../types/ttsProvider';

/** 单段合成结果。 */
export interface TtsSynthesizeResult {
  /** 实际落盘的 wav 路径（= 请求的 outWavPath）。 */
  wavPath: string;
  /** 实测时长（ms，读 WAV 头）。 */
  durationMs: number;
}

/** TTS service 分发函数签名：按 provider.type 路由到具体实现。 */
export type TtsSynthesizer = (
  provider: TtsProvider,
  request: TtsSegmentRequest,
) => Promise<TtsSynthesizeResult>;
