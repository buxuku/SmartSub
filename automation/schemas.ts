import { z } from 'zod';

export const file = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.startsWith('/') ||
      /^[A-Za-z]:[\\/]/.test(value) ||
      /^\\\\[^\\]+\\[^\\]+/.test(value),
    'Absolute local path required',
  )
  .describe('Absolute local file or directory path on the SmartSub host.');
const str = z.string().min(1);
export const style = z
  .object({
    fontName: str.optional(),
    fontSize: z.number().min(10).max(72).optional(),
    primaryColor: str.optional(),
    outlineColor: str.optional(),
    backColor: str.optional(),
    backOpacity: z.number().min(0).max(100).optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    borderStyle: z.union([z.literal(1), z.literal(3)]).optional(),
    outline: z.number().min(0).max(10).optional(),
    shadow: z.number().min(0).max(10).optional(),
    alignment: z.number().int().min(1).max(9).optional(),
    marginL: z.number().min(0).optional(),
    marginR: z.number().min(0).optional(),
    marginV: z.number().min(0).optional(),
    positionY: z.number().min(0).max(100).optional(),
    secondLineColor: str.optional(),
    highlightTerms: z.array(str).optional(),
    highlightColor: str.optional(),
    glow: z.number().min(0).optional(),
    glowColor: str.optional(),
  })
  .passthrough();
export const composeConfig = z
  .object({
    outputMode: z.enum(['hardcode', 'softmux']).default('hardcode'),
    videoQuality: z.enum(['original', 'high', 'standard']).optional(),
    encoderMode: z.enum(['cpu', 'hardware']).optional(),
    style: style.optional(),
    audioTrack: z
      .object({
        mode: z.enum(['replace', 'mix', 'addTrack']),
        trackPath: file,
        duckRatio: z.number().positive().optional(),
      })
      .optional(),
  })
  .strict();
export const dubEngine = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), modelId: str }),
  z.object({ kind: z.literal('cloud'), providerId: str }),
]);
export const pipelineDub = z
  .object({
    engine: dubEngine,
    voice: str,
    language: str.optional(),
    globalSpeed: z.number().min(0.5).max(2).default(1),
    cloneQuality: z.enum(['standard', 'high']).optional(),
    localConcurrency: z.number().int().min(1).max(3).optional(),
    overflow: z.enum(['truncate', 'shift']).optional(),
    overlapMode: z.enum(['shift', 'mix']).optional(),
  })
  .strict();
export const dubbingConfig = pipelineDub.extend({
  background: z.enum(['mute', 'duck']).default('mute'),
  output: z
    .enum(['audioOnly', 'replaceTrack', 'mixTrack', 'addTrack'])
    .default('audioOnly'),
  audioFormat: z.enum(['wav', 'mp3']).optional(),
  exportShiftedSubtitle: z.boolean().optional(),
});
export const pipelineConfig = z
  .object({
    dub: pipelineDub
      .optional()
      .describe(
        'Opt-in dubbing. Use models.list for local TTS or providers.list(kind="tts") for cloud; choose a compatible voice with tts.voices or voices.list. Chat and ASR services cannot provide TTS.',
      ),
    compose: z
      .object({
        subtitle: z.enum(['hard', 'soft', 'none']),
        style: style.optional(),
        styleId: str.optional(),
        styleName: str.optional(),
        videoQuality: composeConfig.shape.videoQuality,
        encoderMode: composeConfig.shape.encoderMode,
      })
      .optional(),
    gates: z
      .object({
        subtitle: z.enum(['auto', 'manual']).default('auto'),
        dubbing: z.enum(['auto', 'manual']).default('auto'),
      })
      .optional(),
    asrProviderId: str
      .optional()
      .describe(
        'Cloud ASR provider ID from providers.list(kind="asr"). Requires engine="cloud" and a model in that provider\'s models list. Independent from translation/refinement/chat.',
      ),
    translateProvider: str
      .optional()
      .describe(
        'Translation provider ID from providers.list(kind="translation"). Required for translate and translating pipelines; "-1" is not a valid translation selection.',
      ),
    useEmbeddedSubtitles: z.boolean().optional(),
    translateContent: z
      .enum(['onlyTranslate', 'sourceAndTranslate', 'translateAndSource'])
      .optional(),
    subtitleOutputFormats: z
      .array(z.enum(['srt', 'vtt', 'ass', 'lrc', 'txt']))
      .min(1)
      .optional(),
    subtitleLayout: z.enum(['original', 'two-line']).optional(),
    subtitleLineWidth: z.number().positive().optional(),
    maxSubtitleChars: z.number().min(-1).optional(),
    subtitleMaxDuration: z.number().positive().optional(),
    subtitleMaxGap: z.number().min(0).optional(),
    preserveSpeechPauses: z
      .boolean()
      .optional()
      .describe(
        'Preserve speech gaps during subtitle segmentation. Does not require an AI provider by itself.',
      ),
    aiSegmentation: z
      .boolean()
      .optional()
      .describe(
        'Opt-in AI semantic segmentation of ASR output. Defaults to false for automation. Requires a configured AI refineProvider; do not enable just to generate original SRT.',
      ),
    aiCorrection: z
      .boolean()
      .optional()
      .describe(
        'Opt-in AI correction of ASR text. Defaults to false for automation. Requires a configured AI refineProvider.',
      ),
    refineProvider: str
      .optional()
      .describe(
        'AI provider ID from providers.list(kind="translation") with isAi=true and configured=true. Required for AI segmentation/correction. Omitted or "follow-translation" uses the task translation provider. The in-app assistant can use its current AI service when omitted and no task service resolves. Explicit selections are never replaced.',
      ),
    subtitleTranslationStyle: z
      .enum(['neutral', 'conversational'])
      .optional()
      .describe(
        'Defaults to neutral. Conversational style requires a configured AI translation provider, including translate-only tasks.',
      ),
    speakerDiarization: z
      .boolean()
      .optional()
      .describe(
        'Opt-in speaker identification for media. Requires installed speaker models and Sherpa runtime; inspect models.list before enabling.',
      ),
    speakerDiarizationCount: z.number().int().min(0).max(8).optional(),
    speakerDiarizationEmbedInSubtitle: z.boolean().optional(),
    manuscriptPath: file.optional(),
  })
  .passthrough()
  .describe(
    'Task overrides. Optional AI refinement, speaker identification, dubbing, composition and manuscript inputs are disabled unless supplied here. Engine/model/provider preferences are inherited from settings.get.defaults. Further IFormData fields are accepted for compatibility; see types/types.ts.',
  );
export const mediaConfigs = {
  trim: z
    .object({
      startSec: z.number().min(0),
      endSec: z.number().positive(),
      mode: z.enum(['lossless', 'accurate']).default('lossless'),
      outputPath: file.optional(),
      outputDir: file.optional(),
    })
    .strict(),
  'extract-audio': z
    .object({
      format: z.enum(['mp3', 'wav', 'aac', 'm4a', 'flac']),
      bitrate: z.enum(['128k', '192k', '256k', '320k']).optional(),
      wavPreset: z.enum(['standard', 'asr_16k_mono']).optional(),
      outputPath: file.optional(),
    })
    .strict(),
  compress: z
    .object({
      preset: z.enum([
        'wechat_25mb',
        'balanced_1080p',
        'fast_720p',
        'target_size',
      ]),
      targetSizeMb: z.number().positive().optional(),
      outputPath: file.optional(),
    })
    .strict(),
  gif: z
    .object({
      startSec: z.number().min(0),
      endSec: z.number().positive(),
      fps: z.number().positive().optional(),
      width: z.number().int().positive().optional(),
      outputPath: file.optional(),
    })
    .strict(),
};
export const syncConfig = z
  .object({
    mode: z.enum(['offset', 'scale', 'two-point']).default('offset'),
    offsetMs: z.number().optional(),
    scaleRatio: z.number().positive().optional(),
    scaleFraction: z
      .object({
        numerator: z.number().positive(),
        denominator: z.number().positive(),
      })
      .optional(),
    p1SourceMs: z.number().min(0).optional(),
    p1TargetMs: z.number().min(0).optional(),
    p2SourceMs: z.number().min(0).optional(),
    p2TargetMs: z.number().min(0).optional(),
    outputPath: file.optional(),
  })
  .strict();
export const downloadConfig = z
  .object({
    name: str,
    savePath: file,
    quality: z.enum(['best', '1080p', '720p']).default('best'),
    engine: z.enum(['auto', 'yt-dlp', 'lux']).default('auto'),
    writeSubs: z.boolean().default(true),
    concurrency: z.number().int().min(1).max(5).optional(),
    entries: z
      .array(
        z.object({
          url: z.string().url(),
          expandPlaylist: z.boolean().optional(),
          meta: z.record(z.unknown()).optional(),
        }),
      )
      .min(1),
    autoChain: z
      .object({
        recipeId: str,
        cloudUploadConsent: z.boolean().optional(),
        configKey: str,
      })
      .optional(),
  })
  .strict();
