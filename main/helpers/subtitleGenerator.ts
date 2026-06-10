import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { getPath, loadWhisperAddon } from './whisper';
import { logMessage, store } from './storeManager';
import { formatSrtContent } from './fileUtils';
import { IFiles } from '../../types';
import { getExtraResourcesPath } from './utils';

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
      use_gpu: backend !== 'cpu',
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
