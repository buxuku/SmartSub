import path from 'path';
import fs from 'fs';
import type { EngineStatus } from '../../../types/engine';
import { getPath, loadWhisperAddon } from '../whisper';
import { logMessage, store } from '../storeManager';
import { formatSrtContent } from '../fileUtils';
import {
  trimSubtitleTrailingSilence,
  energySpeechSegments,
} from '../subtitleTiming';
import {
  tokensToTriples,
  groupTokenCues,
  mergeShortCues,
  enforceMinDisplayDuration,
  getSubtitleCueOptions,
  getMergeShortCueOptions,
  resplitSubtitleCues,
  clampTriplesToSpeechSegments,
  clampCuesToDominantSegments,
  dropCuesInDeepSilence,
  vadSegmentsToSpeech,
} from '../subtitleSegmentation';
import { getExtraResourcesPath } from '../utils';
import {
  getTaskContext,
  isWhisperAbortError,
  isWhisperCancelledResult,
  TaskCancelledError,
  throwIfTaskCancelled,
} from '../taskContext';
import {
  getWhisperLanguage,
  getVadSettings,
  isReduceRepetitionEnabled,
  getNumericSetting,
} from './transcribeShared';
import { resolveEffectiveSettings } from './outcomePresets';
import type { TranscribeContext, TranscriptionEngineAdapter } from './types';

/**
 * 使用内置 whisper.cpp 库生成字幕。取消经 whisperParams.signal 原生中断。
 */
async function transcribeBuiltin(ctx: TranscribeContext): Promise<string> {
  const { event, file, formData } = ctx;
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'loading' });

  try {
    const { tempAudioFile, srtFile } = file;
    const { model, sourceLanguage, prompt } = formData as {
      model?: string;
      sourceLanguage?: string;
      prompt?: string;
    };
    const whisperModel = model?.toLowerCase();
    // 逐任务运行时派生（字幕效果档位 → 底层参数，按引擎差异化），不回写全局。
    const settings = resolveEffectiveSettings(
      formData,
      store.get('settings') as Record<string, unknown>,
    );

    // 加载链内部按 gpuMode + 环境自动决策并逐级降级（见 addonLoader）
    const { whisperAsync, backend, variant } =
      await loadWhisperAddon(whisperModel);
    const backendLabels: Record<string, string> = {
      vulkan: 'Vulkan',
      cpu: 'CPU',
      metal: 'Metal',
      coreml: 'CoreML',
      custom: 'Custom',
    };
    const whisperBackend =
      backend === 'cuda' && variant !== null && variant !== 'vulkan'
        ? `CUDA ${variant}`
        : backendLabels[backend] || backend;
    // 把实际后端推给任务卡片（useIpcCommunication 做通用 merge）
    event.sender.send('taskFileChange', {
      ...file,
      extractSubtitle: 'loading',
      whisperBackend,
    });
    const modelPath = `${getPath('modelsPath')}/ggml-${whisperModel}.bin`;

    // VAD 模型路径 - 使用内置的 VAD 模型
    const vadModelPath = path.join(
      getExtraResourcesPath(),
      'ggml-silero-v6.2.0.bin',
    );

    const vad = getVadSettings(settings as Record<string, unknown>);
    const signal = ctx.signal ?? getTaskContext()?.signal;
    const whisperParams = {
      language: getWhisperLanguage(sourceLanguage),
      model: modelPath,
      fname_inp: tempAudioFile,
      use_gpu: backend !== 'cpu',
      flash_attn: false,
      no_prints: false,
      comma_in_time: false,
      translate: false,
      no_timestamps: false,
      audio_ctx: 0,
      // 原生 segment-aware token 时间轴：token_timestamps=true + max_len=0 让 addon 逐 token
      // 输出 { text, t0, t1, p }（毫秒，已映射回原始时间轴，段间停顿天然以 token gap 体现）。
      // 旧版加速包无 token 输出 → result.tokens 为空，消费段自动回退段级 transcription。
      token_timestamps: true,
      max_len: 0,
      print_progress: true,
      prompt,
      // max_context 由「字幕效果档位」派生（clean 档=0；accurate/balanced=-1；custom 档
      // 回落用户的 maxContext + reduceRepetition 既有语义）。这是 whisper.cpp 打断重复/
      // 幻觉级联的关键杠杆，不再被独立开关静默覆盖（见 outcomePresets / design D4）。
      max_context: isReduceRepetitionEnabled(settings)
        ? 0
        : getNumericSetting(settings.maxContext, -1),
      // VAD 参数
      vad: vad.useVAD,
      vad_model: vadModelPath,
      vad_threshold: vad.vadThreshold,
      vad_min_speech_duration_ms: vad.vadMinSpeechDuration,
      vad_min_silence_duration_ms: vad.vadMinSilenceDuration,
      vad_max_speech_duration_s: vad.vadMaxSpeechDuration,
      vad_speech_pad_ms: vad.vadSpeechPad,
      vad_samples_overlap: vad.vadSamplesOverlap,
      progress_callback: (progress: number) => {
        if (signal?.aborted) return;
        event.sender.send(
          'taskProgressChange',
          file,
          'extractSubtitle',
          progress,
        );
      },
      signal,
    };

    logMessage(
      `whisperParams: ${JSON.stringify({ ...whisperParams, signal: whisperParams.signal ? '[AbortSignal]' : undefined }, null, 2)}`,
      'info',
    );
    event.sender.send('taskProgressChange', file, 'extractSubtitle', 0);
    throwIfTaskCancelled();
    const result = await whisperAsync(whisperParams);

    if (isWhisperCancelledResult(result) || signal?.aborted) {
      if (file.srtFile && fs.existsSync(file.srtFile)) {
        try {
          fs.unlinkSync(file.srtFile);
        } catch {
          /* ignore partial srt cleanup failure */
        }
      }
      logMessage(`generate subtitle cancelled for ${file.fileName}`, 'warning');
      throw new TaskCancelledError();
    }

    // 细粒度时间轴：优先消费原生逐 token 输出（result.tokens，t0/t1 毫秒、已 segment-aware
    // 映射回原始时间轴）。停顿还原据 whisper 内部 VAD 是否开启分两支（消除外部 Silero 双 VAD）：
    //   · VAD 开（均衡/最干净）：token 落在内部 VAD 段 → 逐 token 夹回语音段（clampTriplesToSpeechSegments）
    //     → groupTokenCues → mergeShortCues。停顿与模型无关地稳定还原。
    //   · VAD 关（文字最准）：token 时间全程线性、无段间停顿，逐 token clamp 会切碎词 → 改用能量法
    //     估语音段，成句后做 cue 级主导段收敛 + 深静音丢弃（clampCuesToDominantSegments / dropCuesInDeepSilence）。
    //   两支末尾共用 enforceMinDisplayDuration（最短可读护栏）→ trimSubtitleTrailingSilence（裁尾兜底）。
    //
    // 能力探测兼容：旧版加速包不输出 result.tokens（数组为空）→ 回退段级 result.transcription
    // （whisper 内部 VAD 映射后的整句时间轴），仅做裁尾，保证不崩、可用（≈细粒度管道之前的表现）。
    const nativeTokens = (result?.tokens ?? []) as Array<{
      text: string;
      t0: number;
      t1: number;
      p?: number;
    }>;
    // whisper 内部 VAD 语音段（addon 免费暴露；VAD 关 / 旧加速包时为空）。
    const vadSegments = (result?.vadSegments ?? []) as Array<{
      t0: number;
      t1: number;
    }>;
    const cueOptions = getSubtitleCueOptions(
      formData as Record<string, unknown>,
    );
    const mergeOptions = getMergeShortCueOptions(
      formData as Record<string, unknown>,
    );
    let subtitles;
    if (nativeTokens.length > 0) {
      const triples = tokensToTriples(nativeTokens);
      const internalSpeech = vadSegmentsToSpeech(vadSegments);
      let refined;
      if (internalSpeech.length > 0) {
        // VAD 开：token 已落在 whisper 内部 VAD 段（段感知映射）→ 逐 token 夹回语音段即稳，
        // 段间停顿与模型无关地还原（消除 medium 把 token 摊过人工静音导致的糊穿静音）。
        refined = mergeShortCues(
          groupTokenCues(
            clampTriplesToSpeechSegments(triples, internalSpeech),
            cueOptions,
          ),
          mergeOptions,
        );
      } else {
        // VAD 关（文字最准档）：token 时间是全程线性、无段间停顿，逐 token clamp 会切碎词、
        // 产 0 时长碎片。改用能量法估语音段，成句后做 cue 级「主导段」收敛 + 深静音幻觉丢弃——
        // 与模型无关地还原停顿且不碎词。能量不可用 → 仅成句（优雅降级，等于原行为）。
        const energy = energySpeechSegments(tempAudioFile);
        const grouped = groupTokenCues(triples, cueOptions);
        refined = energy.length
          ? dropCuesInDeepSilence(
              mergeShortCues(
                clampCuesToDominantSegments(grouped, energy),
                mergeOptions,
              ),
              energy,
            )
          : mergeShortCues(grouped, mergeOptions);
      }
      // 词级路径不补文本级 resplit：宽度上限已由 groupTokenCues（含硬切回溯）在真实
      // token 时间上保证，叠比例插值只会劣化时间轴（resplit 仅留给下方段级回退）。
      const spaced = enforceMinDisplayDuration(refined);
      subtitles = trimSubtitleTrailingSilence(spaced, tempAudioFile);
    } else {
      logMessage(
        '内置加速包未返回 token 级时间戳（旧版加速包）：回退段级时间轴，建议更新加速包以启用细粒度字幕',
        'warning',
      );
      subtitles = trimSubtitleTrailingSilence(
        resplitSubtitleCues(
          result?.transcription || [],
          formData as Record<string, unknown>,
        ),
        tempAudioFile,
      );
    }
    const formattedSrt = formatSrtContent(subtitles);
    await fs.promises.writeFile(srtFile, formattedSrt);

    event.sender.send('taskFileChange', { ...file, extractSubtitle: 'done' });
    logMessage(`generate subtitle done!`, 'info');

    return srtFile;
  } catch (error) {
    const aborted =
      isWhisperAbortError(error) ||
      Boolean(ctx.signal?.aborted) ||
      Boolean(getTaskContext()?.signal?.aborted);
    if (aborted) {
      if (file.srtFile && fs.existsSync(file.srtFile)) {
        try {
          fs.unlinkSync(file.srtFile);
        } catch {
          /* ignore partial srt cleanup failure */
        }
      }
      logMessage(`generate subtitle cancelled for ${file.fileName}`, 'warning');
      throw new TaskCancelledError();
    }
    logMessage(`generate subtitle error: ${error}`, 'error');
    throw error;
  }
}

export const builtinEngineAdapter: TranscriptionEngineAdapter = {
  id: 'builtin',
  displayName: 'whisper.cpp (builtin)',
  requiresRuntime: false,

  async isAvailable(): Promise<EngineStatus> {
    return { state: 'ready' };
  },

  async transcribe(ctx: TranscribeContext): Promise<string> {
    return transcribeBuiltin(ctx);
  },

  cancelActive(): void {
    // builtin 经 whisperParams.signal 原生中断，无需额外动作。
  },
};
