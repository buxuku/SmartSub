import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';
import { getPath, loadWhisperAddonRuntime } from './whisper';
import { logMessage, store } from './storeManager';
import { formatSrtContent } from './fileUtils';
import { IFiles } from '../../types';
import { getExtraResourcesPath } from './utils';

/**
 * 使用本地Whisper命令行工具生成字幕
 */
export async function generateSubtitleWithLocalWhisper(
  event,
  file,
  formData,
  isCancellationRequested?: () => boolean,
) {
  const { model, sourceLanguage } = formData;
  const whisperModel = model?.toLowerCase();
  const settings = store.get('settings');
  const whisperCommand = settings?.whisperCommand;
  const { tempAudioFile, srtFile, directory } = file;

  let runShell = whisperCommand
    .replace(/\${audioFile}/g, tempAudioFile)
    .replace(/\${whisperModel}/g, whisperModel)
    .replace(/\${srtFile}/g, srtFile)
    .replace(/\${sourceLanguage}/g, sourceLanguage || 'auto')
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
    if (isCancellationRequested?.()) {
      reject(new Error('任务已取消'));
      return;
    }

    let settled = false;
    let cancelTimer: ReturnType<typeof setInterval>;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(cancelTimer);
      callback();
    };

    const child = exec(runShell, (error, stdout, stderr) => {
      if (isCancellationRequested?.()) {
        finish(() => reject(new Error('任务已取消')));
        return;
      }
      if (error) {
        finish(() => {
          logMessage(`generate subtitle error: ${error}`, 'error');
          reject(error);
        });
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
      finish(() => resolve(srtFile));
    });

    cancelTimer = setInterval(() => {
      if (isCancellationRequested?.()) {
        child.kill();
        finish(() => reject(new Error('任务已取消')));
      }
    }, 500);
  });
}

/**
 * 使用内置Whisper库生成字幕
 */
export async function generateSubtitleWithBuiltinWhisper(
  event,
  file: IFiles,
  formData,
  isCancellationRequested?: () => boolean,
) {
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'loading' });

  try {
    if (isCancellationRequested?.()) {
      throw new Error('任务已取消');
    }

    const { tempAudioFile, srtFile } = file;
    console.log(tempAudioFile, srtFile, file, 'tempAudioFile, srtFile');
    const { model, sourceLanguage, prompt, maxContext } = formData;
    const whisperModel = model?.toLowerCase();
    const runtime = await loadWhisperAddonRuntime(whisperModel);
    const whisperAsync = promisify(runtime.whisper);
    const settings = store.get('settings');
    const shouldUseGpu = runtime.supportsGpu;
    const modelPath = `${getPath('modelsPath')}/ggml-${whisperModel}.bin`;

    // VAD 模型路径 - 使用内置的 VAD 模型
    const vadModelPath = path.join(
      getExtraResourcesPath(),
      'ggml-silero-v6.2.0.bin',
    );

    // 获取VAD设置
    const vadSettings = {
      useVAD: settings.useVAD !== false, // 默认启用
      vadThreshold: settings.vadThreshold || 0.5,
      vadMinSpeechDuration: settings.vadMinSpeechDuration || 250,
      vadMinSilenceDuration: settings.vadMinSilenceDuration || 100,
      vadMaxSpeechDuration:
        settings.vadMaxSpeechDuration === undefined
          ? 0
          : Number(settings.vadMaxSpeechDuration),
      vadSpeechPad: settings.vadSpeechPad || 30,
      vadSamplesOverlap: settings.vadSamplesOverlap || 0.1,
    };
    const hasVadModel = fs.existsSync(vadModelPath);
    if (vadSettings.useVAD && !hasVadModel) {
      logMessage(
        `VAD model not found: ${vadModelPath}; VAD disabled`,
        'warning',
      );
    }

    const whisperParams = {
      language: sourceLanguage || 'auto',
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
      vad: vadSettings.useVAD && hasVadModel,
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
    const result = (await whisperAsync(whisperParams)) as {
      transcription?: [string, string, string][];
    };
    if (isCancellationRequested?.()) {
      throw new Error('任务已取消');
    }
    console.log(result, 'result');

    // 格式化字幕内容
    const formattedSrt = formatSrtContent(result?.transcription || []);
    if (!formattedSrt.trim()) {
      throw new Error('转录结果为空，无法生成字幕');
    }

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
