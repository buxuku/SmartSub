import path from 'path';
import fs from 'fs';
import { logMessage, store } from './storeManager';
import { createMessageSender } from './messageHandler';
import { getSrtFileName } from './utils';
import { extractAudioFromVideo } from './audioProcessor';
import { generateSubtitleWithLocalWhisper, generateSubtitleWithBuiltinWhisper } from './subtitleGenerator';
import translate from '../translate';

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
async function generateSubtitle(event, file, audioFile, srtFile, formData, hasOpenAiWhisper) {
  const settings = store.get('settings');
  const useLocalWhisper = settings?.useLocalWhisper;

  try {
    if (hasOpenAiWhisper && useLocalWhisper && settings?.whisperCommand) {
      return await generateSubtitleWithLocalWhisper(event, file, audioFile, srtFile, formData);
    } else {
      return await generateSubtitleWithBuiltinWhisper(event, file, audioFile, srtFile, formData);
    }
  } catch (error) {
    onError(event, file, 'extractSubtitle', error);
    throw error; // 继续抛出错误，以便上层函数知道发生了错误
  }
}

/**
 * 翻译字幕
 */
async function translateSubtitle(event, file, directory, fileName, srtFile, formData, provider, retry = 0) {
  event.sender.send('taskStatusChange', file, 'translateSubtitle', 'loading');

  const onProgress = (progress) => {
    event.sender.send('taskProgressChange', file, 'translateSubtitle', Math.min(progress, 100));
  };
  try {
    await translate(event, directory, fileName, srtFile, formData, provider, onProgress);
    event.sender.send('taskStatusChange', file, 'translateSubtitle', 'done');
  } catch (error) {
    if (retry >= +(formData?.translateRetryTimes || 0)) {
      onError(event, file, 'translateSubtitle', error);
      return;
    }
    logMessage(`translateSubtitle error: ${error.message}, retry ${retry + 1}`, 'error');
    await translateSubtitle(event, file, directory, fileName, srtFile, formData, provider, retry + 1);
  }
}

/**
 * 处理文件
 */
export async function processFile(event, file, formData, hasOpenAiWhisper, provider) {
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
    const { filePath } = file;
    let directory = path.dirname(filePath);
    let fileName = path.basename(filePath, path.extname(filePath));
    const fileExtension = path.extname(filePath).toLowerCase();

    const isSubtitleFile = ['.srt', '.vtt', '.ass', '.ssa'].includes(fileExtension);
    let srtFile = filePath;
    logMessage(`begin process ${fileName} with task type: ${taskType}`, 'info');

    // 确定是否需要生成字幕
    const shouldGenerateSubtitle = taskType === 'generateAndTranslate' || taskType === 'generateOnly';

    // 确定是否需要翻译字幕
    const shouldTranslateSubtitle = taskType === 'generateAndTranslate' || taskType === 'translateOnly';

    // 处理非字幕文件 - 需要生成字幕的情况
    if (!isSubtitleFile && shouldGenerateSubtitle) {
      const templateData = { fileName, sourceLanguage, targetLanguage, model, translateProvider: provider.name };

      const sourceSrtFileName = getSrtFileName(
        sourceSrtSaveOption,
        fileName,
        sourceLanguage,
        customSourceSrtFileName,
        templateData
      );

      srtFile = path.join(directory, `${sourceSrtFileName}`);

      try {
        // 提取音频
        logMessage(`extract audio for ${fileName}`, 'info');
        event.sender.send('taskStatusChange', file, 'extractAudio', 'loading');
        const tempAudioFile = await extractAudioFromVideo(event, file, filePath);
        event.sender.send('taskStatusChange', file, 'extractAudio', 'done');

        // 如果开启了保存音频选项，则复制一份到视频同目录
        if (saveAudio) {
          const audioFileName = `${fileName}.wav`;
          const targetAudioPath = path.join(directory, audioFileName);
          logMessage(`Saving audio file to: ${targetAudioPath}`, 'info');
          fs.copyFileSync(tempAudioFile, targetAudioPath);
        }

        // 生成字幕
        logMessage(`generate subtitle ${srtFile}`, 'info');
        srtFile = await generateSubtitle(
          event,
          file,
          tempAudioFile,
          srtFile,
          formData,
          hasOpenAiWhisper
        );
      } catch (error) {
        // 如果是提取音频或生成字幕过程中出错，已经在各自的函数中处理了错误状态
        // 这里只需要继续抛出错误，中断后续流程
        throw error;
      }
    } else if (isSubtitleFile) {
      // 处理字幕文件
      try {
        event.sender.send('taskStatusChange', file, 'prepareSubtitle', 'loading');
        // 这里可以添加字幕格式转换的逻辑，如果需要的话
        event.sender.send('taskStatusChange', file, 'prepareSubtitle', 'done');
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
      logMessage(`translate subtitle ${srtFile}`, 'info');
      await translateSubtitle(
        event,
        file,
        directory,
        fileName,
        srtFile,
        formData,
        provider
      );
    }

    // 清理临时文件
    if (!isSubtitleFile && sourceSrtSaveOption === 'noSave' && shouldGenerateSubtitle) {
      logMessage(`delete temp subtitle ${srtFile}`, 'warning');
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
