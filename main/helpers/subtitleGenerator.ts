import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';
import { getPath, loadWhisperAddon } from './whisper';
import { checkCudaSupport } from './cudaUtils';
import { logMessage, store } from './storeManager';
import { formatSrtContent } from './fileUtils';
import { IFiles } from '../../types';
import { getExtraResourcesPath } from './utils';
import { getPythonEngineManager } from './pythonEngine';

function getNumericSetting(value: unknown, defaultValue: number): number {
  return typeof value === 'number' && isFinite(value) ? value : defaultValue;
}

function getWhisperLanguage(language?: string): string {
  if (!language || language === 'auto') {
    return 'auto';
  }

  const normalized = language.toLowerCase();
  // 所有中文变体（简体/繁体/台湾/香港等）统一映射为 zh，
  // Whisper 对 zh 的训练数据最充分，识别国语/普通话最准确；
  // 粤语请通过下拉框单独选择 yue 传入。
  if (normalized.startsWith('zh')) {
    return 'zh';
  }

  return normalized;
}

/**
 * 使用本地Whisper命令行工具生成字幕
 */
export async function generateSubtitleWithLocalWhisper(event, file, formData) {
  const { model, sourceLanguage } = formData;
  const whisperModel = model?.toLowerCase();
  const settings = store.get('settings');
  const whisperCommand = settings?.whisperCommand;
  const { tempAudioFile, srtFile, directory } = file;

  let runShell = whisperCommand
    .replace(/\${audioFile}/g, tempAudioFile)
    .replace(/\${whisperModel}/g, whisperModel)
    .replace(/\${srtFile}/g, srtFile)
    .replace(/\${sourceLanguage}/g, getWhisperLanguage(sourceLanguage))
    .replace(/\${outputDir}/g, directory);

  runShell = runShell.replace(/("[^"]*")|(\S+)/g, (match, quoted, unquoted) => {
    if (quoted) return quoted;
    if (unquoted && (unquoted.includes('/') || unquoted.includes('\\'))) {
      return `"${unquoted}"`;
    }
    return unquoted || match;
  });

  console.log(runShell, 'runShell');
  logMessage(`run shell ${runShell}`, 'info');
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'loading' });

  return new Promise((resolve, reject) => {
    exec(runShell, (error, stdout, stderr) => {
      if (error) {
        logMessage(`generate subtitle error: ${error}`, 'error');
        reject(error);
        return;
      }
      if (stderr) {
        logMessage(`generate subtitle stderr: ${stderr}`, 'warning');
      }
      if (stdout) {
        logMessage(`generate subtitle stdout: ${stdout}`, 'info');
      }
      logMessage(`generate subtitle done!`, 'info');

      const md5BaseName = path.basename(tempAudioFile, '.wav');
      const tempSrtFile = path.join(directory, `${md5BaseName}.srt`);
      if (fs.existsSync(tempSrtFile)) {
        fs.renameSync(tempSrtFile, srtFile);
      }

      event.sender.send('taskFileChange', { ...file, extractSubtitle: 'done' });
      resolve(srtFile);
    });
  });
}

/** 秒(float)转 SRT 时间戳 HH:MM:SS.mmm(formatSrtContent 会把 . 换成 ,) */
function secondsToSrtTime(seconds: number): string {
  // 先整体取整到毫秒,避免 59.9995s 这类值出现 ms=1000 的进位问题
  const totalMs = Math.round(Math.max(0, seconds || 0) * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const pad = (value: number, len = 2) => String(value).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

/**
 * ggml 模型名映射为 faster-whisper 模型 id:
 * 量化后缀(-q5_0/-q5_1/-q8_0)是 whisper.cpp 特有概念,faster-whisper
 * 由 compute_type 控制精度,直接剥掉后缀取基础模型。
 */
function toFasterWhisperModel(model?: string): string {
  const base = (model || 'base').toLowerCase().replace(/-q\d+_\d+$/, '');
  return base;
}

/**
 * 使用 Python sidecar 中的 faster-whisper 生成字幕。
 * 模型按需自动下载(HF_HOME 已收敛到 userData/py-engine-cache)。
 */
export async function generateSubtitleWithFasterWhisper(
  event,
  file: IFiles,
  formData,
) {
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'loading' });

  const { tempAudioFile, srtFile } = file;
  const { model, sourceLanguage, prompt } = formData;
  const settings = store.get('settings');

  const manager = getPythonEngineManager();
  let engineInfo;
  try {
    engineInfo = await manager.ensureStarted();
  } catch (error) {
    throw new Error(
      `faster-whisper engine unavailable: ${error?.message || error}`,
    );
  }
  if (!engineInfo?.engines?.faster_whisper) {
    throw new Error(
      'faster-whisper is not available in the python engine runtime',
    );
  }

  const params = {
    engine: 'faster_whisper',
    audio_file: tempAudioFile,
    model: toFasterWhisperModel(model),
    language: getWhisperLanguage(sourceLanguage),
    device: settings.fasterWhisperDevice || 'auto',
    compute_type: settings.fasterWhisperComputeType || 'auto',
    initial_prompt: prompt || '',
    vad: settings.useVAD !== false,
    vad_threshold: getNumericSetting(settings.vadThreshold, 0.5),
    vad_min_speech_duration_ms: getNumericSetting(
      settings.vadMinSpeechDuration,
      250,
    ),
    vad_min_silence_duration_ms: getNumericSetting(
      settings.vadMinSilenceDuration,
      100,
    ),
    vad_speech_pad_ms: getNumericSetting(settings.vadSpeechPad, 30),
  };
  logMessage(`fasterWhisperParams: ${JSON.stringify(params, null, 2)}`, 'info');
  event.sender.send('taskProgressChange', file, 'extractSubtitle', 0);

  const { result } = manager.transcribe(params, {
    onProgress: (percent) => {
      event.sender.send('taskProgressChange', file, 'extractSubtitle', percent);
    },
  });
  const transcription = await result;

  const formattedSrt = formatSrtContent(
    (transcription?.segments || []).map(
      (segment) =>
        [
          secondsToSrtTime(segment.start),
          secondsToSrtTime(segment.end),
          segment.text || '',
        ] as [string, string, string],
    ),
  );
  await fs.promises.writeFile(srtFile, formattedSrt);

  event.sender.send('taskProgressChange', file, 'extractSubtitle', 100);
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'done' });
  logMessage(
    `generate subtitle done (faster-whisper, language=${transcription?.language})`,
    'info',
  );
  return srtFile;
}

/**
 * 使用内置Whisper库生成字幕
 */
export async function generateSubtitleWithBuiltinWhisper(
  event,
  file: IFiles,
  formData,
) {
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'loading' });

  try {
    const { tempAudioFile, srtFile } = file;
    console.log(tempAudioFile, srtFile, file, 'tempAudioFile, srtFile');
    const { model, sourceLanguage, prompt, maxContext } = formData;
    const whisperModel = model?.toLowerCase();
    const settings = store.get('settings');
    const useCuda = settings.useCuda || false;
    const platform = process.platform;
    const arch = process.arch;

    // 修改 GPU 判断逻辑
    let shouldUseGpu = false;
    let canUseCuda = false;
    if (platform === 'darwin' && arch === 'arm64') {
      shouldUseGpu = true;
    } else if ((platform === 'win32' || platform === 'linux') && useCuda) {
      canUseCuda = !!(await checkCudaSupport());
      shouldUseGpu = canUseCuda;
    }
    const whisper = await loadWhisperAddon(whisperModel, canUseCuda);
    const whisperAsync = promisify(whisper);
    const modelPath = `${getPath('modelsPath')}/ggml-${whisperModel}.bin`;

    // VAD 模型路径 - 使用内置的 VAD 模型
    const vadModelPath = path.join(
      getExtraResourcesPath(),
      'ggml-silero-v6.2.0.bin',
    );

    // 获取VAD设置
    const vadSettings = {
      useVAD: settings.useVAD !== false, // 默认启用
      vadThreshold: getNumericSetting(settings.vadThreshold, 0.5),
      vadMinSpeechDuration: getNumericSetting(
        settings.vadMinSpeechDuration,
        250,
      ),
      vadMinSilenceDuration: getNumericSetting(
        settings.vadMinSilenceDuration,
        100,
      ),
      vadMaxSpeechDuration: getNumericSetting(settings.vadMaxSpeechDuration, 0), // 0表示无限制
      vadSpeechPad: getNumericSetting(settings.vadSpeechPad, 30),
      vadSamplesOverlap: getNumericSetting(settings.vadSamplesOverlap, 0.1),
    };
    const whisperParams = {
      language: getWhisperLanguage(sourceLanguage),
      model: modelPath,
      fname_inp: tempAudioFile,
      use_gpu: !!shouldUseGpu,
      flash_attn: false,
      no_prints: false,
      comma_in_time: false,
      translate: false,
      no_timestamps: false,
      audio_ctx: 0,
      max_len: 0,
      print_progress: true,
      prompt,
      max_context: +(maxContext ?? -1),
      // VAD 参数
      vad: vadSettings.useVAD,
      vad_model: vadModelPath,
      vad_threshold: vadSettings.vadThreshold,
      vad_min_speech_duration_ms: vadSettings.vadMinSpeechDuration,
      vad_min_silence_duration_ms: vadSettings.vadMinSilenceDuration,
      vad_max_speech_duration_s: vadSettings.vadMaxSpeechDuration,
      vad_speech_pad_ms: vadSettings.vadSpeechPad,
      vad_samples_overlap: vadSettings.vadSamplesOverlap,
      progress_callback: (progress) => {
        console.log(`处理进度: ${progress}%`);
        // 更新UI显示进度
        event.sender.send(
          'taskProgressChange',
          file,
          'extractSubtitle',
          progress,
        );
      },
    };

    logMessage(
      `whisperParams: ${JSON.stringify(whisperParams, null, 2)}`,
      'info',
    );
    event.sender.send('taskProgressChange', file, 'extractSubtitle', 0);
    const result = await whisperAsync(whisperParams);
    console.log(result, 'result');

    // 格式化字幕内容
    const formattedSrt = formatSrtContent(result?.transcription || []);

    // 写入格式化后的内容
    await fs.promises.writeFile(srtFile, formattedSrt);

    event.sender.send('taskFileChange', { ...file, extractSubtitle: 'done' });
    logMessage(`generate subtitle done!`, 'info');

    return srtFile;
  } catch (error) {
    logMessage(`generate subtitle error: ${error}`, 'error');
    throw error;
  }
}
