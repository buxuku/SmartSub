import os from 'os';
import path from 'path';
import fs from 'fs';
import {
  isTtsProviderConfigured,
  type TtsProvider,
} from '../../../types/ttsProvider';
import { synthesizeSegment, defaultVoiceOf } from './index';

export interface TtsTestResult {
  ok: boolean;
  /** 缺少必填配置（key / base url / voices），供前端提示「先填配置」。 */
  needsConfig?: boolean;
  /** 失败原因（服务端错误 / 断供引导等），前端直接展示。 */
  detail?: string;
}

const TEST_TIMEOUT_MS = 20_000;

/**
 * 云 TTS 实例连通性自测：真实合成一句短文本（TTS 无零成本探针，对齐 design 决策 2）。
 * 计费影响可忽略（"Hello" 5 字符）；成功即证明凭据、模型与 voice 全链路可用。
 * 返回结构对齐 ASR testConnection（ok / needsConfig / detail）。
 */
export async function testTtsConnection(
  provider: TtsProvider,
): Promise<TtsTestResult> {
  if (!isTtsProviderConfigured(provider)) {
    return { ok: false, needsConfig: true };
  }
  const voice = defaultVoiceOf(provider);
  if (!voice) return { ok: false, needsConfig: true };

  const outWavPath = path.join(
    os.tmpdir(),
    `smartsub-tts-test-${Date.now()}.wav`,
  );
  try {
    const result = await synthesizeSegment(provider, {
      text: 'Hello',
      voice,
      outWavPath,
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    return result.durationMs > 0
      ? { ok: true }
      : { ok: false, detail: 'empty audio' };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      if (fs.existsSync(outWavPath)) fs.unlinkSync(outWavPath);
    } catch {
      /* ignore */
    }
  }
}
