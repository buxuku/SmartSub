import path from 'path';
import fs from 'fs-extra';
import { v4 as uuidv4 } from 'uuid';
import { IFiles } from '../../types';
import { logMessage } from './storeManager';
import { ensureTempDir } from './fileUtils';
import { createMessageSender } from './messageHandler';
import {
  detectSubtitleFormatByExtension,
  parseSubtitleCues,
  SubtitleCue,
} from './subtitleFormats';
import {
  DubCue,
  DurationStrategy,
  trimSilence,
  normalizeSegmentRms,
  planDubbingTimeline,
  placedCuesToSrt,
  analyzePlacements,
  PlacedCue,
} from './dubbingAlignment';
import {
  getInstalledTtsModels,
  resolveTtsSelection,
  getTtsModelRequest,
  TTS_DEFAULT_VOICE_SID,
  TtsModelId,
} from './ttsModelCatalog';
import { getTtsProviderById } from './ttsProviderManager';
import { synthesizeCloudTts } from '../service/tts';
import { isTtsProviderConfigured } from '../../types/ttsProvider';
import {
  getSherpaTtsRuntime,
  releaseSherpaTtsRuntime,
} from './sherpaOnnx/ttsRuntime';
import {
  writePcm16Wav,
  readPcm16Wav,
  ffmpegAtempo,
  encodeAudioMp3,
  canSoftMuxContainer,
  muxSoftAudioTrack,
  probeEmbeddedSubtitles,
  extractEmbeddedSubtitle,
} from './audioProcessor';
import { detectSubtitlesForVideo } from './subtitleDetector';
import { canHaveEmbeddedSubtitle, srtHasCues } from './embeddedSubtitleParser';
import {
  throwIfTaskCancelled,
  isTaskCancelledError,
  TaskCancelledError,
  getTaskSignal,
} from './taskContext';

const ATEMPO_CONCURRENCY = 4;
const SUBTITLE_EXTENSIONS = ['.srt', '.vtt', '.ass', '.ssa', '.lrc'];

interface SynthSegment {
  index: number;
  samples: Float32Array;
  speechDurationSec: number;
}

function onDubbingError(event: any, file: IFiles, key: string, error: unknown) {
  const errorMsg =
    (error as Error)?.message || String(error ?? '') || '未知错误';
  logMessage(`dubbing ${key} error: ${errorMsg}`, 'error');
  event.sender.send('taskStatusChange', file, key, 'error');
  event.sender.send('taskErrorChange', file, key, errorMsg);
  createMessageSender(event.sender).send('message', {
    type: 'error',
    message: errorMsg,
  });
}

function cueToDubCue(c: SubtitleCue): DubCue {
  return {
    start: c.startMs / 1000,
    end: c.endMs / 1000,
    text: c.text.replace(/\n/g, ' ').trim(),
  };
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

async function resolveSubtitlePath(
  file: IFiles,
  formData: Record<string, unknown>,
): Promise<string> {
  const { filePath, fileExtension } = file;

  if (SUBTITLE_EXTENSIONS.includes(fileExtension)) {
    return filePath;
  }

  const detection = await detectSubtitlesForVideo(
    filePath,
    String(formData?.sourceLanguage || ''),
    String(formData?.targetLanguage || ''),
  );
  const subs = detection.detectedSubtitles;
  if (subs.length > 0) {
    const translated = subs.find((s) => s.type === 'translated');
    const source = subs.find((s) => s.type === 'source');
    const picked = translated || source || subs[0];
    logMessage(`dubbing: using sidecar subtitle ${picked.filePath}`, 'info');
    return picked.filePath;
  }

  if (canHaveEmbeddedSubtitle(fileExtension)) {
    const textTracks = (await probeEmbeddedSubtitles(filePath)).filter(
      (t) => t.isText,
    );
    if (textTracks.length > 0) {
      const tempSrt = path.join(
        ensureTempDir(),
        `dub-embed-${file.uuid || uuidv4()}.srt`,
      );
      await extractEmbeddedSubtitle(
        filePath,
        textTracks[0].subIndex,
        tempSrt,
        null,
        null,
      );
      const content = fs.readFileSync(tempSrt, 'utf-8');
      if (srtHasCues(content)) {
        file.tempSrtFile = tempSrt;
        return tempSrt;
      }
      try {
        fs.unlinkSync(tempSrt);
      } catch {
        /* ignore */
      }
    }
  }

  throw new Error('未找到字幕');
}

function removeTempPaths(paths: string[]): void {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        if (stat.isDirectory()) {
          fs.rmSync(p, { recursive: true, force: true });
        } else {
          fs.unlinkSync(p);
        }
      }
    } catch (err) {
      logMessage(`dubbing cleanup failed ${p}: ${err}`, 'warning');
    }
  }
}

/**
 * 字幕配音任务主流程：解析 → 逐句合成 → 对齐规划 → atempo → 拼装整轨 → 导出。
 */
export async function processTtsFile(
  event: any,
  file: IFiles,
  formData: Record<string, unknown>,
): Promise<void> {
  const signal = getTaskSignal();
  const tempPaths: string[] = [];
  let activeStage = 'prepareSubtitle';

  for (const k of [
    'prepareSubtitle',
    'extractSubtitle',
    'translateSubtitle',
    'prepareSubtitleProgress',
    'extractSubtitleProgress',
    'translateSubtitleProgress',
    'prepareSubtitleError',
    'extractSubtitleError',
    'translateSubtitleError',
  ]) {
    delete (file as Record<string, unknown>)[k];
  }

  const cleanup = () => {
    removeTempPaths(tempPaths);
    if (formData?.ttsSource !== 'cloud') {
      releaseSherpaTtsRuntime();
    }
  };

  try {
    const ttsSource =
      formData?.ttsSource === 'cloud' ? 'cloud' : ('local' as const);
    let modelId: TtsModelId | undefined;
    let voiceSid = 0;
    let cloudProvider =
      ttsSource === 'cloud'
        ? getTtsProviderById(formData?.ttsProviderId as string)
        : undefined;

    if (ttsSource === 'cloud') {
      if (!cloudProvider || !isTtsProviderConfigured(cloudProvider)) {
        throw new Error('云端 TTS 未配置，请先在「引擎与模型」页添加服务商');
      }
    } else {
      const installed = getInstalledTtsModels();
      const selection = resolveTtsSelection(
        formData?.ttsModelId as string | undefined,
        installed,
      );
      if (!selection) {
        throw new Error('TTS 模型未安装，请先在「引擎与模型」页下载配音模型');
      }
      modelId = selection.id;
      voiceSid = Number(
        formData?.ttsVoiceSid ??
          TTS_DEFAULT_VOICE_SID[modelId as TtsModelId] ??
          0,
      );
    }
    const strategy =
      (formData?.durationStrategy as DurationStrategy) || 'balanced';
    const exportAlignedSrt = formData?.exportAlignedSrt !== false;
    const outputFormat =
      formData?.dubbingOutputFormat === 'mp3' ? 'mp3' : 'wav';
    const outputMode =
      formData?.dubbingOutputMode === 'softMux' ? 'softMux' : 'audioOnly';
    const isMediaInput = !SUBTITLE_EXTENSIONS.includes(file.fileExtension);

    // ── 阶段 1：解析字幕 ──────────────────────────────────────────────
    activeStage = 'prepareSubtitle';
    event.sender.send('taskFileChange', {
      ...file,
      prepareSubtitle: 'loading',
    });
    event.sender.send('taskProgressChange', file, 'prepareSubtitle', 0);
    throwIfTaskCancelled();

    const subtitlePath = await resolveSubtitlePath(file, formData);
    file.srtFile = subtitlePath;

    const format = detectSubtitleFormatByExtension(subtitlePath) || 'srt';
    const content = await fs.promises.readFile(subtitlePath, 'utf-8');
    const rawCues = parseSubtitleCues(content, format);
    const cues = rawCues.map(cueToDubCue).filter((c) => c.text.length > 0);
    if (cues.length === 0) {
      throw new Error('字幕无有效台词');
    }

    event.sender.send('taskFileChange', { ...file, prepareSubtitle: 'done' });
    event.sender.send('taskProgressChange', file, 'prepareSubtitle', 100);

    // ── 阶段 2：逐句合成（speed=1.0，时长压缩走 atempo）──────────────
    activeStage = 'extractSubtitle';
    event.sender.send('taskFileChange', {
      ...file,
      extractSubtitle: 'loading',
    });
    event.sender.send('taskProgressChange', file, 'extractSubtitle', 0);
    throwIfTaskCancelled();

    const workDirEarly = path.join(ensureTempDir(), `dub-${uuidv4()}`);
    await fs.ensureDir(workDirEarly);
    tempPaths.push(workDirEarly);

    let sampleRate = 24_000;
    const runtime = ttsSource === 'local' ? getSherpaTtsRuntime() : null;
    const req =
      ttsSource === 'local' && modelId ? getTtsModelRequest(modelId) : null;
    if (runtime && req) {
      const meta = await runtime.load(req);
      sampleRate = meta.sampleRate;
    }

    const segments: SynthSegment[] = [];
    const total = cues.length;
    for (let i = 0; i < total; i++) {
      throwIfTaskCancelled();
      let audioSamples: Float32Array;
      if (ttsSource === 'cloud' && cloudProvider) {
        const cloudWav = path.join(workDirEarly, `cloud-${i}.wav`);
        await synthesizeCloudTts(cloudProvider, {
          text: cues[i].text,
          outWavPath: cloudWav,
          signal,
        });
        const decoded = readPcm16Wav(cloudWav);
        if (i === 0) sampleRate = decoded.sampleRate;
        audioSamples = decoded.samples;
      } else if (runtime && req) {
        const { result } = runtime.synthesize(
          req,
          cues[i].text,
          voiceSid,
          1.0,
          signal,
        );
        const audio = await result;
        if (i === 0) sampleRate = audio.sampleRate;
        audioSamples = audio.samples;
      } else {
        throw new Error('TTS runtime unavailable');
      }
      const trimmed = trimSilence(audioSamples, sampleRate);
      const normalized = normalizeSegmentRms(trimmed);
      segments.push({
        index: i,
        samples: normalized,
        speechDurationSec: normalized.length / sampleRate,
      });
      const pct = Math.round(((i + 1) / total) * 100);
      event.sender.send('taskProgressChange', file, 'extractSubtitle', pct);
    }

    event.sender.send('taskFileChange', { ...file, extractSubtitle: 'done' });

    // ── 阶段 3：对齐 + atempo + 拼装 ─────────────────────────────────
    activeStage = 'translateSubtitle';
    event.sender.send('taskFileChange', {
      ...file,
      translateSubtitle: 'loading',
    });
    event.sender.send('taskProgressChange', file, 'translateSubtitle', 0);
    throwIfTaskCancelled();

    const speechDurations = segments.map((s) => s.speechDurationSec);
    const placements = planDubbingTimeline(cues, speechDurations, strategy);

    const workDir = workDirEarly;

    const rawWavs = segments.map((seg, i) => {
      const wavPath = path.join(workDir, `raw-${i}.wav`);
      writePcm16Wav(seg.samples, sampleRate, wavPath);
      return wavPath;
    });

    throwIfTaskCancelled();
    const processedSamples = await mapPool(
      placements,
      ATEMPO_CONCURRENCY,
      async (placement: PlacedCue) => {
        throwIfTaskCancelled();
        const seg = segments[placement.index];
        if (placement.atempoFactor <= 1.001) {
          return seg.samples;
        }
        const outWav = path.join(workDir, `tempo-${placement.index}.wav`);
        await ffmpegAtempo(
          rawWavs[placement.index],
          outWav,
          placement.atempoFactor,
          signal,
        );
        return readPcm16Wav(outWav).samples;
      },
    );

    throwIfTaskCancelled();
    const lastPlaced = placements[placements.length - 1];
    const totalSec =
      Math.max(
        lastPlaced.start + lastPlaced.durationSec,
        cues[cues.length - 1].end,
      ) + 0.3;
    const track = new Float32Array(Math.ceil(totalSec * sampleRate));
    for (let pi = 0; pi < placements.length; pi++) {
      const p = placements[pi];
      const samples = processedSamples[pi];
      const off = Math.round(p.start * sampleRate);
      for (let i = 0; i < samples.length && off + i < track.length; i++) {
        track[off + i] = samples[i];
      }
    }

    const baseName = path.basename(file.filePath, file.fileExtension);
    const modelTag =
      ttsSource === 'cloud'
        ? `cloud-${String(formData?.ttsProviderId || 'default').slice(0, 8)}`
        : String(modelId).replace(/[^a-zA-Z0-9]+/g, '-');
    const voiceTag = ttsSource === 'cloud' ? 'cloud' : `s${voiceSid}`;
    const outBase = `${baseName}.dub.${modelTag}.${voiceTag}`;
    const outWav = path.join(file.directory, `${outBase}.wav`);
    writePcm16Wav(track, sampleRate, outWav);
    file.dubAudioFile = outWav;

    let finalAudio = outWav;
    if (outputFormat === 'mp3') {
      throwIfTaskCancelled();
      const outMp3 = path.join(file.directory, `${outBase}.mp3`);
      await encodeAudioMp3(outWav, outMp3, signal);
      file.dubAudioFile = outMp3;
      finalAudio = outMp3;
    }

    if (exportAlignedSrt) {
      const alignedSrt = placedCuesToSrt(placements);
      const outSrt = path.join(file.directory, `${outBase}.aligned.srt`);
      await fs.writeFile(outSrt, alignedSrt, 'utf-8');
      file.alignedSrtFile = outSrt;
    }

    event.sender.send('taskProgressChange', file, 'translateSubtitle', 100);
    event.sender.send('taskFileChange', { ...file, translateSubtitle: 'done' });

    // ── 阶段 4（可选）：软封装附加音轨 ───────────────────────────────
    if (outputMode === 'softMux' && isMediaInput) {
      activeStage = 'extractAudio';
      if (!canSoftMuxContainer(file.fileExtension)) {
        logMessage(
          `dubbing: container ${file.fileExtension} does not support soft mux, audio-only output kept`,
          'warning',
        );
      } else {
        throwIfTaskCancelled();
        event.sender.send('taskFileChange', {
          ...file,
          extractAudio: 'loading',
        });
        event.sender.send('taskProgressChange', file, 'extractAudio', 0);
        const outVideo = path.join(
          file.directory,
          `${outBase}${file.fileExtension}`,
        );
        await muxSoftAudioTrack(file.filePath, finalAudio, outVideo, signal);
        file.dubVideoFile = outVideo;
        event.sender.send('taskProgressChange', file, 'extractAudio', 100);
        event.sender.send('taskFileChange', { ...file, extractAudio: 'done' });
        logMessage(`dubbing soft mux → ${outVideo}`, 'info');
      }
    }

    const report = analyzePlacements(placements);
    if (report.overlapTotalSec > 0.001) {
      logMessage(
        `dubbing overlap warning: ${report.overlapTotalSec.toFixed(4)}s`,
        'warning',
      );
    }
    logMessage(
      `dubbing done: ${cues.length} cues, drift max ${report.maxStartDriftSec.toFixed(2)}s → ${file.dubAudioFile}`,
      'info',
    );

    cleanup();
  } catch (error) {
    cleanup();
    if (isTaskCancelledError(error)) {
      throw error instanceof TaskCancelledError
        ? error
        : new TaskCancelledError();
    }
    onDubbingError(event, file, activeStage, error);
    throw error;
  }
}

/** 估算待配音字幕总字符数（用于云端成本提示；无法解析字幕的文件跳过）。 */
export async function estimateDubbingCharCount(
  files: IFiles[],
  formData: Record<string, unknown>,
): Promise<number> {
  let total = 0;
  for (const file of files) {
    try {
      const subPath = await resolveSubtitlePath(file, formData);
      const ext = path.extname(subPath).toLowerCase();
      const format = detectSubtitleFormatByExtension(ext);
      const content = await fs.readFile(subPath, 'utf-8');
      const cues = parseSubtitleCues(content, format);
      for (const c of cues) {
        total += c.text.replace(/\s/g, '').length;
      }
    } catch {
      // 无字幕或探测失败：不计入
    }
  }
  return total;
}
