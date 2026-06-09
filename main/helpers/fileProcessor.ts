import path from 'path';
import fs from 'fs';
import { logMessage, store } from './storeManager';
import { createMessageSender } from './messageHandler';
import { getSrtFileName } from './utils';
import { extractAudioFromVideo } from './audioProcessor';
import {
  generateSubtitleWithLocalWhisper,
  generateSubtitleWithBuiltinWhisper,
} from './subtitleGenerator';
import translate from '../translate';
import { ensureTempDir, getMd5 } from './fileUtils';
import { IFiles } from '../../types';
import {
  convertSubtitleContent,
  getFormatExtension,
  isSupportedSubtitleFormat,
  SubtitleFormat,
} from './subtitleFormats';

/**
 * 处理任务错误
 */
function onError(event, file, key, error) {
  const errorMsg = error?.message || error?.toString() || '未知错误';
  logMessage(`${key} error: ${errorMsg}`, 'error');
  event.sender.send('taskStatusChange', file, key, 'error');
  event.sender.send('taskErrorChange', file, key, errorMsg);

  // 发送错误消息通知
  createMessageSender(event.sender).send('message', {
    type: 'error',
    message: errorMsg,
  });
}

/**
 * 生成字幕
 */
async function generateSubtitle(
  event,
  file: IFiles,
  formData,
  hasOpenAiWhisper,
) {
  const settings = store.get('settings');
  const useLocalWhisper = settings?.useLocalWhisper;

  try {
    if (hasOpenAiWhisper && useLocalWhisper && settings?.whisperCommand) {
      return await generateSubtitleWithLocalWhisper(event, file, formData);
    } else {
      return await generateSubtitleWithBuiltinWhisper(event, file, formData);
    }
  } catch (error) {
    onError(event, file, 'extractSubtitle', error);
    throw error; // 继续抛出错误，以便上层函数知道发生了错误
  }
}

/**
 * 解析用户选择的输出字幕格式，非法值回退为 srt。
 */
function resolveOutputFormat(formData): SubtitleFormat {
  const fmt = formData?.subtitleOutputFormat;
  return isSupportedSubtitleFormat(fmt) ? fmt : 'srt';
}

/**
 * 将规范 SRT 交付字幕转换为目标格式，写入新扩展名文件并删除原 .srt。
 * 整个处理流程内部始终使用 SRT，仅在最终交付物上做一次格式转换，
 * 以隔离各格式差异、最大限度降低对既有流程的影响。
 * 返回转换后的新文件路径。
 */
async function convertDeliverable(
  srtPath: string,
  format: SubtitleFormat,
): Promise<string> {
  const ext = getFormatExtension(format);
  const newPath = srtPath.replace(/\.srt$/i, ext);
  const content = await fs.promises.readFile(srtPath, 'utf-8');
  const converted = convertSubtitleContent(content, 'srt', format);
  await fs.promises.writeFile(newPath, converted, 'utf-8');
  if (newPath !== srtPath) {
    try {
      fs.unlinkSync(srtPath);
    } catch (err) {
      logMessage(`删除中间 srt 文件失败: ${err}`, 'warning');
    }
  }
  return newPath;
}

/**
 * 翻译字幕
 */
async function translateSubtitle(event, file: IFiles, formData, provider) {
  // 强制发送翻译开始状态
  event.sender.send('taskFileChange', {
    ...file,
    translateSubtitle: 'loading',
    translateSubtitleProgress: 0,
  });

  // 强制发送初始进度
  event.sender.send('taskProgressChange', file, 'translateSubtitle', 0);

  const onProgress = (progress) => {
    const normalizedProgress = Math.min(Math.max(progress, 0), 100);
    event.sender.send(
      'taskProgressChange',
      file,
      'translateSubtitle',
      normalizedProgress,
    );
  };

  try {
    await translate(event, file, formData, provider, onProgress);

    // 确保最终状态的正确发送
    event.sender.send('taskProgressChange', file, 'translateSubtitle', 100);
    event.sender.send('taskFileChange', {
      ...file,
      translateSubtitle: 'done',
      translateSubtitleProgress: 100,
    });

    logMessage(
      `Translation completed successfully for ${file.fileName}`,
      'info',
    );
  } catch (error) {
    // 确保错误状态下也发送当前进度（从文件状态获取）
    onError(event, file, 'translateSubtitle', error);
  }
}

/**
 * 处理文件
 */
export async function processFile(
  event,
  file: IFiles,
  formData,
  hasOpenAiWhisper,
  provider,
) {
  const {
    sourceLanguage,
    targetLanguage,
    sourceSrtSaveOption,
    customSourceSrtFileName,
    model,
    translateProvider,
    saveAudio,
    taskType,
  } = formData || {};

  try {
    const { filePath, fileName, fileExtension, directory } = file;
    console.log('filePath', file);

    const isSubtitleFile = ['.srt', '.vtt', '.ass', '.ssa', '.lrc'].includes(
      fileExtension,
    );
    logMessage(`begin process ${fileName} with task type: ${taskType}`, 'info');

    // 确定是否需要生成字幕
    const shouldGenerateSubtitle =
      taskType === 'generateAndTranslate' || taskType === 'generateOnly';

    // 确定是否需要翻译字幕
    const shouldTranslateSubtitle =
      taskType === 'generateAndTranslate' || taskType === 'translateOnly';

    // 处理非字幕文件 - 需要生成字幕的情况
    if (!isSubtitleFile && shouldGenerateSubtitle) {
      const templateData = {
        fileName,
        sourceLanguage,
        targetLanguage,
        model,
        translateProvider: provider.name,
      };

      const sourceSrtFileName = getSrtFileName(
        sourceSrtSaveOption,
        fileName,
        sourceLanguage,
        customSourceSrtFileName,
        templateData,
      );

      file.srtFile = path.join(directory, `${sourceSrtFileName}.srt`);

      try {
        // 提取音频
        logMessage(`extract audio for ${fileName}`, 'info');
        event.sender.send('taskFileChange', {
          ...file,
          extractAudio: 'loading',
        });
        const tempAudioFile = await extractAudioFromVideo(event, file);
        event.sender.send('taskFileChange', { ...file, extractAudio: 'done' });

        // 如果开启了保存音频选项，则复制一份到视频同目录
        if (saveAudio) {
          const audioFileName = `${fileName}.wav`;
          const targetAudioPath = path.join(directory, audioFileName);
          file.audioFile = targetAudioPath;
          logMessage(`Saving audio file to: ${targetAudioPath}`, 'info');
          fs.copyFileSync(tempAudioFile, targetAudioPath);
        }

        // 生成字幕
        logMessage(`generate subtitle ${file.srtFile}`, 'info');
        await generateSubtitle(event, file, formData, hasOpenAiWhisper);
      } catch (error) {
        // 如果是提取音频或生成字幕过程中出错，已经在各自的函数中处理了错误状态
        // 这里只需要继续抛出错误，中断后续流程
        throw error;
      }
    } else if (isSubtitleFile) {
      // 处理字幕文件
      file.srtFile = filePath;
      try {
        event.sender.send('taskFileChange', {
          ...file,
          prepareSubtitle: 'loading',
        });
        // 这里可以添加字幕格式转换的逻辑，如果需要的话
        event.sender.send('taskFileChange', {
          ...file,
          prepareSubtitle: 'done',
        });
      } catch (error) {
        onError(event, file, 'prepareSubtitle', error);
        throw error;
      }
    } else if (!isSubtitleFile && !shouldGenerateSubtitle) {
      // 非字幕文件且不需要生成字幕的情况（只翻译模式下传入了视频文件）
      const errorMsg = '只翻译模式下不能处理视频文件，请提供字幕文件';
      onError(event, file, 'processFile', new Error(errorMsg));
      throw new Error(errorMsg);
    }

    // 翻译字幕
    if (shouldTranslateSubtitle && translateProvider !== '-1') {
      logMessage(`translate subtitle ${file.srtFile}`, 'info');
      await translateSubtitle(event, file, formData, provider);
    }

    // 将交付字幕转换为用户选择的输出格式（内部流程始终为 SRT，此处仅转换最终交付物）
    const outputFormat = resolveOutputFormat(formData);
    if (outputFormat !== 'srt') {
      // 源字幕：仅在由 ASR 生成且需要保存时转换（noSave 时源字幕会被清理，保持 srt）
      if (
        !isSubtitleFile &&
        shouldGenerateSubtitle &&
        sourceSrtSaveOption !== 'noSave' &&
        file.srtFile &&
        fs.existsSync(file.srtFile)
      ) {
        try {
          file.srtFile = await convertDeliverable(file.srtFile, outputFormat);
          logMessage(`source subtitle converted to ${outputFormat}`, 'info');
        } catch (err) {
          logMessage(`转换源字幕格式失败: ${err}`, 'error');
        }
      }
      // 翻译字幕交付物
      if (
        shouldTranslateSubtitle &&
        translateProvider !== '-1' &&
        file.translatedSrtFile &&
        fs.existsSync(file.translatedSrtFile)
      ) {
        try {
          file.translatedSrtFile = await convertDeliverable(
            file.translatedSrtFile,
            outputFormat,
          );
          logMessage(
            `translated subtitle converted to ${outputFormat}`,
            'info',
          );
        } catch (err) {
          logMessage(`转换翻译字幕格式失败: ${err}`, 'error');
        }
      }
      event.sender.send('taskFileChange', file);
    }

    // 清理临时文件
    if (
      !isSubtitleFile &&
      sourceSrtSaveOption === 'noSave' &&
      shouldGenerateSubtitle
    ) {
      const { srtFile } = file;
      logMessage(`delete temp subtitle ${srtFile}`, 'warning');
      // 缓存一份到临时文件，用于字幕校对
      const tempDir = ensureTempDir();
      const md5FileName = getMd5(filePath);
      const tempSrtFile = path.join(tempDir, `${md5FileName}.srt`);
      file.tempSrtFile = tempSrtFile;
      // 清除已删除文件的路径，确保校对时使用临时目录的文件
      file.srtFile = undefined;
      event.sender.send('taskFileChange', file);
      fs.copyFileSync(srtFile, tempSrtFile);
      fs.unlink(srtFile, (err) => {
        if (err) console.log(err);
      });
    }

    logMessage(`process file done ${fileName}`, 'info');
  } catch (error) {
    // 使用通用错误处理方法
    createMessageSender(event.sender).send('message', {
      type: 'error',
      message: error,
    });
  }
}
