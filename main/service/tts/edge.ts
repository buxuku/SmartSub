import fs from 'fs';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import type {
  TtsProvider,
  TtsSegmentRequest,
} from '../../../types/ttsProvider';
import type { TtsSynthesizeResult } from './types';
import { TaskCancelledError } from '../../helpers/taskContext';
import {
  transcodeToPcm16Wav,
  readWavInfo,
} from '../../helpers/dubbing/audioPipeline';

/**
 * Edge TTS（微软 Edge Read Aloud 逆向接口，经 msedge-tts）。
 *
 * 选型记录（2026-07，任务 5.3）：msedge-tts v2.0.6（2026-06 发版，周下载 32K，41KB）
 * vs edge-tts-universal v1.4.0（2026-02 发版）。两者都已修复 2025-12 断供
 * （UA/WebSocket 头收紧），msedge-tts 更新更勤、体积更小、真实合成实测通过 → 选定。
 * 该通道定位「免费试用档，不承诺可用性」：接口随时可能再断，错误信息引导切换。
 */

/** speed（1=原速）→ Edge rate 百分比串（+20% / -10%）。 */
export function speedToEdgeRate(speed: number | undefined): string {
  const s = Number(speed);
  if (!Number.isFinite(s) || s <= 0) return '+0%';
  const pct = Math.round((Math.min(3, Math.max(0.5, s)) - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

/** 断供类错误的引导文案（拼在原始错误后，UI 直接展示）。 */
const EDGE_OUTAGE_HINT =
  'Edge TTS 免费通道不可用（逆向接口可能已变更或被限制）。该通道不承诺可用性，建议切换本地模型或 OpenAI 兼容服务商。';

function toPositiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 单段合成：mp3 流收齐 → ffmpeg 统一转 16-bit PCM 单声道 wav。 */
export async function synthesizeWithEdge(
  provider: TtsProvider,
  request: TtsSegmentRequest,
): Promise<TtsSynthesizeResult> {
  const timeoutMs = toPositiveNumber(provider.requestTimeoutSec, 60) * 1000;
  const mp3 = await synthesizeEdgeMp3(
    request.text,
    request.voice,
    speedToEdgeRate(request.speed),
    timeoutMs,
    request.signal,
  );

  const tmp = `${request.outWavPath}.edge-${Date.now()}.mp3`;
  fs.writeFileSync(tmp, mp3);
  try {
    await transcodeToPcm16Wav(tmp, request.outWavPath, {
      signal: request.signal,
    });
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
  return {
    wavPath: request.outWavPath,
    durationMs: readWavInfo(request.outWavPath).durationMs,
  };
}

function synthesizeEdgeMp3(
  text: string,
  voice: string,
  rate: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TaskCancelledError());
      return;
    }
    const tts = new MsEdgeTTS();
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try {
        tts.close();
      } catch {
        /* ignore */
      }
      fn();
    };
    const onAbort = () => finish(() => reject(new TaskCancelledError()));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              `Edge TTS 请求超时（${timeoutMs / 1000}s）。${EDGE_OUTAGE_HINT}`,
            ),
          ),
        ),
      timeoutMs,
    );
    signal?.addEventListener('abort', onAbort, { once: true });

    (async () => {
      await tts.setMetadata(
        voice,
        OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
      );
      const { audioStream } = await tts.toStream(text, { rate });
      const chunks: Buffer[] = [];
      audioStream.on('data', (c: Buffer) => chunks.push(c));
      audioStream.on('end', () =>
        finish(() => {
          const buf = Buffer.concat(chunks);
          if (buf.length === 0) {
            reject(new Error(`Edge TTS 返回空音频。${EDGE_OUTAGE_HINT}`));
          } else {
            resolve(buf);
          }
        }),
      );
      audioStream.on('error', (e: Error) =>
        finish(() =>
          reject(
            new Error(`Edge TTS 流错误：${e.message}。${EDGE_OUTAGE_HINT}`),
          ),
        ),
      );
    })().catch((e) =>
      finish(() =>
        reject(
          new Error(
            `Edge TTS 连接失败：${e instanceof Error ? e.message : String(e)}。${EDGE_OUTAGE_HINT}`,
          ),
        ),
      ),
    );
  });
}
