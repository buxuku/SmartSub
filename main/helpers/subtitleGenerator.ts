import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';
import { getPath, loadWhisperAddon } from './whisper';
import { checkCudaSupport } from './cudaUtils';
import { logMessage, store } from './storeManager';
import { formatSrtContent } from './fileUtils';

/**
 * 使用本地Whisper命令行工具生成字幕
 */
export async function generateSubtitleWithLocalWhisper(
  event,
  file,
  audioFile,
  srtFile,
  formData
) {
  const { model, sourceLanguage } = formData;
  const whisperModel = model?.toLowerCase();
  const settings = store.get('settings');
  const whisperCommand = settings?.whisperCommand;

  let runShell = whisperCommand
    .replace(/\${audioFile}/g, audioFile)
    .replace(/\${whisperModel}/g, whisperModel)
    .replace(/\${srtFile}/g, srtFile)
    .replace(/\${sourceLanguage}/g, sourceLanguage || 'auto')
    .replace(/\${outputDir}/g, path.dirname(srtFile));

  runShell = runShell.replace(/("[^"]*")|(\S+)/g, (match, quoted, unquoted) => {
    if (quoted) return quoted;
    if (unquoted && (unquoted.includes('/') || unquoted.includes('\\'))) {
      return `"${unquoted}"`;
    }
    return unquoted || match;
  });

  console.log(runShell, 'runShell');
  logMessage(`run shell ${runShell}`, 'info');
  event.sender.send('taskStatusChange', file, 'extractSubtitle', 'loading');

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

      const md5BaseName = path.basename(audioFile, '.wav');
      const tempSrtFile = path.join(
        path.dirname(file?.filePath),
        `${md5BaseName}.srt`
      );
      if (fs.existsSync(tempSrtFile)) {
        fs.renameSync(tempSrtFile, srtFile + '.srt');
      }

      event.sender.send('taskStatusChange', file, 'extractSubtitle', 'done');
      resolve(`${srtFile}.srt`);
    });
  });
}

/**
 * 使用内置Whisper库生成字幕
 */
export async function generateSubtitleWithBuiltinWhisper(
  event,
  file,
  audioFile,
  srtFile,
  formData
) {
  event.sender.send('taskStatusChange', file, 'extractSubtitle', 'loading');

  try {
    const { model, sourceLanguage, prompt } = formData;
    const whisperModel = model?.toLowerCase();
    const whisper = await loadWhisperAddon(whisperModel);
    const whisperAsync = promisify(whisper);
    const settings = store.get('settings') || { useCuda: false };
    const useCuda = settings.useCuda || false;
    const platform = process.platform;
    const arch = process.arch;

    // 修改 GPU 判断逻辑
    let shouldUseGpu = false;
    if (platform === 'darwin' && arch === 'arm64') {
      shouldUseGpu = true;
    } else if (platform === 'win32' && useCuda) {
      shouldUseGpu = !!(await checkCudaSupport());
    }
    const modelPath = `${getPath('modelsPath')}/ggml-${whisperModel}.bin`;

    const whisperParams = {
      language: sourceLanguage || 'auto',
      model: modelPath,
      fname_inp: audioFile,
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
      progress_callback: (progress) => {
        console.log(`处理进度: ${progress}%`);
        // 更新UI显示进度
        event.sender.send('taskProgressChange', file, 'extractSubtitle', progress);
      },
    };

    logMessage(
      `whisperParams: ${JSON.stringify(whisperParams, null, 2)}`,
      'info'
    );
    event.sender.send('taskProgressChange', file, 'extractSubtitle', 0);
    const result = await whisperAsync(whisperParams);
    console.log(result, 'result');

    // 格式化字幕内容
    const formattedSrt = formatSrtContent(result);

    // 写入格式化后的内容
    await fs.promises.writeFile(srtFile + '.srt', formattedSrt);

    event.sender.send('taskStatusChange', file, 'extractSubtitle', 'done');
    logMessage(`generate subtitle done!`, 'info');

    return `${srtFile}.srt`;
  } catch (error) {
    logMessage(`generate subtitle error: ${error}`, 'error');
    throw error;
  }
}
