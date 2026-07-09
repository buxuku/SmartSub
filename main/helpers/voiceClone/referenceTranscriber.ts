import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import ffmpegStatic from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import { logMessage } from '../storeManager';
import { ensureTempDir } from '../fileUtils';
import {
  getInstalledFunasrAsrModels,
  getFunasrModelDir,
  getFunasrVadModelPath,
  resolveFunasrAsrSelection,
} from '../funasrModelCatalog';
import { isSherpaLibInstalled } from '../sherpaOnnx/sherpaLibPaths';
import { getSherpaFunasrRuntime } from '../sherpaOnnx/sherpaFunasrRuntime';
import { getAsrProviders } from '../asrProviderManager';
import {
  getAsrProviderType,
  isAsrProviderConfigured,
  parseAsrModels,
} from '../../../types/asrProvider';
import { getAsrTranscriber } from '../../service/asr';

const FFMPEG_BIN = (ffmpegStatic as unknown as string).replace(
  'app.asar',
  'app.asar.unpacked',
);
ffmpeg.setFfmpegPath(FFMPEG_BIN);

/**
 * 参考文本自动转写：本地 funasr（已装优先，免费不出网）→ 用户已配置的
 * 云 ASR 服务商（取第一个就绪实例）→ 均不可用返回 available=false
 * （向导降级为手动输入）。输入为分析副本 wav 的选区（16k mono，切区间后直传）。
 */
export interface ReferenceTranscribeResult {
  available: boolean;
  text?: string;
  /** 转写来源展示名（「本地 SenseVoice」/ 云服务商实例名）。 */
  engineLabel?: string;
  error?: string;
}

/** 切选区临时 wav（分析副本已是 16k mono pcm16，仅裁剪）。 */
async function cutRangeWav(
  analysisWavPath: string,
  startMs: number,
  endMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const outPath = path.join(
    ensureTempDir(),
    `clone-ref-asr-${randomUUID()}.wav`,
  );
  await new Promise<void>((resolve, reject) => {
    const command = ffmpeg(analysisWavPath)
      .setStartTime(startMs / 1000)
      .setDuration(Math.max(0.1, (endMs - startMs) / 1000))
      .audioCodec('pcm_s16le')
      .outputOptions('-y');
    const onAbort = () => {
      try {
        command.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    command
      .on('end', () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      })
      .on('error', (err) => {
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      })
      .save(outPath);
  });
  return outPath;
}

async function transcribeWithLocalFunasr(
  wavPath: string,
  language: 'zh' | 'en',
): Promise<{ text: string; label: string } | null> {
  if (!isSherpaLibInstalled()) return null;
  const installed = getInstalledFunasrAsrModels();
  const selection = resolveFunasrAsrSelection(undefined, installed);
  if (!selection) return null;
  const asrDir = getFunasrModelDir(selection.id);
  const { result } = getSherpaFunasrRuntime().transcribe(
    {
      asrModel: path.join(asrDir, 'model.int8.onnx'),
      tokens: path.join(asrDir, 'tokens.txt'),
      vadModel: getFunasrVadModelPath(),
      modelType: selection.modelType,
      params: {
        vad_threshold: 0.5,
        vad_min_silence_duration_ms: 300,
        vad_min_speech_duration_ms: 200,
        vad_max_speech_duration_s: 0,
        num_threads: 2,
        provider: 'cpu',
        // 素材实际语言可能与用户预选不一致（英文视频 + 默认中文），
        // sense-voice 自动检测更稳；参考文本语言以实际转写结果为准。
        language: 'auto',
        use_itn: true,
      },
    },
    wavPath,
  );
  const { segments } = await result;
  const text = segments
    .map((s: { text: string }) => s.text.trim())
    .filter(Boolean)
    .join(language === 'zh' ? '，' : ', ');
  return text ? { text, label: 'SenseVoice' } : null;
}

async function transcribeWithCloudAsr(
  wavPath: string,
  language: 'zh' | 'en',
  signal?: AbortSignal,
): Promise<{ text: string; label: string } | null> {
  const provider = getAsrProviders().find((p) => {
    const type = getAsrProviderType(p.type);
    return (
      type && isAsrProviderConfigured(p, type) && getAsrTranscriber(p.type)
    );
  });
  if (!provider) return null;
  const transcriber = getAsrTranscriber(provider.type)!;
  const models = parseAsrModels(provider);
  const result = await transcriber(provider, {
    audioPath: wavPath,
    model: String(provider.model || models[0] || 'whisper-1'),
    language,
    signal,
  });
  const text = (result.text || '').trim();
  return text ? { text, label: provider.name } : null;
}

export async function transcribeReferenceRange(
  analysisWavPath: string,
  startMs: number,
  endMs: number,
  language: 'zh' | 'en',
  signal?: AbortSignal,
): Promise<ReferenceTranscribeResult> {
  if (!fs.existsSync(analysisWavPath)) {
    return { available: false, error: 'analysis wav missing' };
  }
  let rangeWav: string | null = null;
  try {
    rangeWav = await cutRangeWav(analysisWavPath, startMs, endMs, signal);
    const local = await transcribeWithLocalFunasr(rangeWav, language).catch(
      (e) => {
        logMessage(`clone ref local asr failed: ${e}`, 'warning');
        return null;
      },
    );
    if (local) {
      return { available: true, text: local.text, engineLabel: local.label };
    }
    const cloud = await transcribeWithCloudAsr(
      rangeWav,
      language,
      signal,
    ).catch((e) => {
      logMessage(`clone ref cloud asr failed: ${e}`, 'warning');
      return null;
    });
    if (cloud) {
      return { available: true, text: cloud.text, engineLabel: cloud.label };
    }
    return { available: false };
  } finally {
    if (rangeWav) {
      try {
        fs.unlinkSync(rangeWav);
      } catch {
        /* ignore */
      }
    }
  }
}
