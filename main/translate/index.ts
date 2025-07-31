import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Provider, TranslationResult } from './types';
import { CONTENT_TEMPLATES } from './constants';
import { parseSubtitles } from './utils/subtitle';
import { createOrClearFile, appendToFile, readFileContent } from './utils/file';
import {
  translateWithProvider,
  TRANSLATOR_MAP,
} from './services/translationProvider';
import { getSrtFileName, renderTemplate } from '../helpers/utils';
import { logMessage } from '../helpers/storeManager';
import { IFiles, IFormData } from '../../types';
import { ensureTempDir } from '../helpers/fileUtils';

export default async function translate(
  event,
  file: IFiles,
  formData: IFormData,
  provider: Provider,
  onProgress?: (progress: number) => void,
  maxRetries?: number,
): Promise<boolean> {
  const {
    translateContent,
    targetSrtSaveOption,
    customTargetSrtFileName,
    sourceLanguage,
    targetLanguage,
    translateRetryTimes,
  } = formData || {};
  const { fileName, directory, srtFile } = file;

  // 如果参数中有指定重试次数，则使用参数值，否则使用表单中的值或默认为2
  const retryCount =
    maxRetries !== undefined
      ? maxRetries
      : translateRetryTimes
        ? parseInt(translateRetryTimes)
        : 0;
  const renderContentTemplate = CONTENT_TEMPLATES[translateContent];

  try {
    const translator = TRANSLATOR_MAP[provider.type];
    if (!translator) {
      throw new Error(`Unknown translation provider: ${provider.type}`);
    }

    logMessage(
      `Translation started using ${provider.type}, max retries: ${retryCount}`,
      'info',
    );

    const data = await readFileContent(srtFile);
    const subtitles = parseSubtitles(data);

    const templateData = {
      fileName,
      sourceLanguage,
      targetLanguage,
      model: '',
      translateProvider: provider.name,
    };
    const targetSrtFileName = getSrtFileName(
      targetSrtSaveOption,
      fileName,
      targetLanguage,
      customTargetSrtFileName,
      templateData,
    );

    const fileSave = path.join(directory, `${targetSrtFileName}.srt`);
    file.translatedSrtFile = fileSave;
    await createOrClearFile(fileSave);

    // 生成临时纯翻译文件，无论是否是双语字幕
    const tempDir = ensureTempDir();
    const tempTranslatedFileName = `${uuidv4()}.srt`;
    const tempTranslatedFilePath = path.join(tempDir, tempTranslatedFileName);
    file.tempTranslatedSrtFile = tempTranslatedFilePath;
    await createOrClearFile(tempTranslatedFilePath);

    logMessage(
      `Created temporary pure translation file: ${tempTranslatedFilePath}`,
      'info',
    );

    const handleTranslationResult = async (results: TranslationResult[]) => {
      let concatContent = '';
      let tempTranslatedContent = '';

      results.forEach(async (result) => {
        // 根据用户设置的模板生成目标文件内容
        const content = `${result.id}\n${result.startEndTime}\n${renderTemplate(
          renderContentTemplate,
          {
            sourceContent: result.sourceContent,
            targetContent: result.targetContent,
          },
        )}`;
        concatContent += content;

        // 对临时文件，只添加纯翻译内容
        const pureTranslatedContent = `${result.id}\n${result.startEndTime}\n${result.targetContent}\n\n`;
        tempTranslatedContent += pureTranslatedContent;
      });

      // 保存到目标文件
      logMessage(`append to file ${fileSave}`);
      await appendToFile(fileSave, concatContent);

      // 保存到临时纯翻译文件
      logMessage(`append to temp file ${tempTranslatedFilePath}`);
      await appendToFile(tempTranslatedFilePath, tempTranslatedContent);
    };

    await translateWithProvider(
      provider,
      subtitles,
      sourceLanguage,
      targetLanguage,
      translator,
      onProgress,
      handleTranslationResult,
      retryCount,
    );

    logMessage('Translation completed', 'info');
    return true;
  } catch (error) {
    event.sender.send('message', error.message || error);
    throw error;
  }
}

export async function testTranslation(
  provider: Provider,
  sourceLanguage: string,
  targetLanguage: string,
): Promise<{ translation: string; analysis?: any }> {
  const testSubtitle = {
    id: '1',
    startEndTime: '00:00:01,000 --> 00:00:04,000',
    content: ['Hello China'],
  };

  try {
    const translator = TRANSLATOR_MAP[provider.type];
    if (!translator) {
      throw new Error(`Unknown translation provider: ${provider.type}`);
    }

    const startTime = Date.now();
    const results = await translateWithProvider(
      provider,
      [testSubtitle],
      sourceLanguage,
      targetLanguage,
      translator,
    );

    let translation: string;
    if (provider.isAi && provider.useBatchTranslation) {
      translation = (results as string[])[0];
    } else {
      translation = (results as TranslationResult[])[0].targetContent;
    }

    // For now, return basic result until we implement full analysis
    // TODO: Add thinking mode analysis when we have access to raw API response
    return {
      translation,
      analysis: {
        response_time_ms: Date.now() - startTime,
        provider_name: provider.name,
        model_name: provider.modelName,
        test_completed: true,
      },
    };
  } catch (error) {
    throw error;
  }
}
