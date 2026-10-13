/**
 * 内置 whisper.cpp 的音频输入适配（Windows 非 ASCII 路径）。
 *
 * addon 用 miniaudio 的窄字符 API（CreateFileA）解码 `fname_inp`。系统代码页不是
 * UTF-8（例如中文版默认的 GBK）时，路径里的中文打不开：addon 只在 stderr 打印
 * `error: failed to read audio file '...'`，然后以 0 段结果「成功」返回——整个任务悄悄变成
 * 空字幕。用户名带中文时，默认临时目录（提取出的 16 kHz wav 就放在这里）就是这种路径。
 * （GitHub Actions windows-latest 实测：模型与 VAD 模型路径含中文能正常加载，只有音频解码失败。）
 *
 * 做法：这种路径由 JS 解码 wav（Node 的 fs 走宽字符 API），以 `pcmf32`（Float32Array）
 * 交给 addon，`fname_inp` 置空串（addon 要求该字段是字符串）。addon 对缓冲输入不写任何
 * 输出文件，其余行为（VAD、token 时间轴、进度、取消）与文件输入一致。
 * 用户音频不会被复制到任何共享目录。
 *
 * 内存：addon 会把缓冲拷贝数份，1 小时 16 kHz 单声道约 230 MB 一份，所以这条兜底路径把
 * 分片阈值从 4 小时降到 1 小时（见 PCM_INPUT_CHUNK_PLAN）。
 *
 * 本模块不引用 electron，便于单测。
 */
import fs from 'fs';
import type { ChunkPlanOptions } from '../builtinAudioChunking';
import { needsNativeSafe } from '../sherpaOnnx/nativeSafePath';

/** whisper 的输入采样率。 */
export const WHISPER_SAMPLE_RATE = 16000;

/**
 * 缓冲输入兜底路径的分片计划：超过 1 小时才分片，每片不超过 30 分钟
 * （默认计划是超过 4 小时才分、每片约 1 小时）。
 */
export const PCM_INPUT_CHUNK_PLAN: ChunkPlanOptions = {
  targetSeconds: 1800,
  activateSeconds: 3600,
};

export type WhisperInputLogLevel = 'info' | 'warning' | 'error';

export interface WhisperAudioInputDeps {
  /** 缺省取 process.platform；测试里用来模拟 Windows */
  platform?: NodeJS.Platform;
  log?: (message: string, level: WhisperInputLogLevel) => void;
}

/** 原生解码是否会打不开该音频路径：仅 Windows 且路径含非 ASCII。 */
export function needsPcmInput(
  audioPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    typeof audioPath === 'string' &&
    audioPath.length > 0 &&
    needsNativeSafe(audioPath, platform)
  );
}

/**
 * 解码 16-bit PCM WAV 的第一声道为 [-1, 1) 的 Float32Array（与 sherpa wav-io 同口径）。
 * 只认应用自己产出的格式（ffmpeg → pcm_s16le）；其它格式、坏文件、读不到都返回 null，
 * 由调用方决定如何回退。
 */
export function readPcm16Wav(
  audioPath: string,
): { samples: Float32Array; sampleRate: number } | null {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(audioPath);
  } catch {
    return null;
  }
  if (
    buf.length < 12 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return null;
  }

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) return null;
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE：SubFormat GUID 的前两个字节才是真正的格式码
      if (format === 0xfffe && size >= 40 && body + 26 <= buf.length) {
        format = buf.readUInt16LE(body + 24);
      }
    } else if (id === 'data') {
      if (format !== 1 || bits !== 16 || channels < 1 || sampleRate < 1) {
        return null;
      }
      // 与 readWavInfo 一致：声明为 0 或超出文件长度（流式写出 / 被截断）时按实际剩余字节
      const available = buf.length - body;
      const dataBytes = size === 0 || size > available ? available : size;
      const frameSize = 2 * channels;
      const frames = Math.floor(dataBytes / frameSize);
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i += 1) {
        samples[i] = buf.readInt16LE(body + i * frameSize) / 32768;
      }
      return { samples, sampleRate };
    }
    // RIFF 子块按偶数字节对齐
    pos = body + size + (size % 2);
  }
  return null;
}

/**
 * 需要时把 whisperAsync 的参数从「文件路径」换成「PCM 缓冲」。
 * 只改 fname_inp / pcmf32，其余参数原样保留，也不修改传入对象；
 * 不适用（ASCII 路径、非 Windows、调用方已给 pcmf32）或解不了时原样返回同一个对象，
 * 行为不会比不处理更差。
 */
export function adaptWhisperAudioInput(
  params: Record<string, unknown>,
  deps: WhisperAudioInputDeps = {},
): Record<string, unknown> {
  const input = params.fname_inp;
  if (
    typeof input !== 'string' ||
    params.pcmf32 !== undefined ||
    !needsPcmInput(input, deps.platform)
  ) {
    return params;
  }
  const log = deps.log ?? (() => undefined);

  const decoded = readPcm16Wav(input);
  if (!decoded || decoded.samples.length === 0) {
    log(
      `whisper input: ${input} is not a readable 16-bit PCM WAV with audio; passing the path through, the native decoder may fail to open it`,
      'warning',
    );
    return params;
  }
  if (decoded.sampleRate !== WHISPER_SAMPLE_RATE) {
    log(
      `whisper input: ${input} is ${decoded.sampleRate} Hz but whisper expects ${WHISPER_SAMPLE_RATE} Hz; passing the path through, the native decoder may fail to open it`,
      'warning',
    );
    return params;
  }
  log(
    `whisper input: the audio path contains non-ASCII characters, which the native decoder cannot open on Windows; feeding ${decoded.samples.length} PCM samples instead (${input})`,
    'info',
  );
  return { ...params, fname_inp: '', pcmf32: decoded.samples };
}

/** 给 whisperAsync 套一层输入适配（见 adaptWhisperAudioInput）；适配过程中的异常以 rejection 返回。 */
export function withNativeSafeAudioInput<
  F extends (params: Record<string, unknown>) => Promise<any>,
>(whisperAsync: F, deps: WhisperAudioInputDeps = {}): F {
  const wrapped = (params: Record<string, unknown>): Promise<any> => {
    let adapted: Record<string, unknown>;
    try {
      adapted = adaptWhisperAudioInput(params, deps);
    } catch (error) {
      return Promise.reject(error);
    }
    return whisperAsync(adapted);
  };
  return wrapped as F;
}
