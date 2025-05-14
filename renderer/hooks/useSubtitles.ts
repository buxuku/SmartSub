import { useState, useEffect } from 'react';
import path from 'path';
import { isSubtitleFile } from 'lib/utils';
import { toast } from 'sonner';
import { useTranslation } from 'next-i18next';
import { IFiles } from '../../types';

// 字幕格式接口
export interface Subtitle {
  id: string;
  startEndTime: string;
  content: string[];
  sourceContent?: string;
  targetContent?: string;
  startTimeInSeconds?: number;
  endTimeInSeconds?: number;
  isEditing?: boolean;
}

export interface SubtitleStats {
  total: number;
  withTranslation: number;
  percent: number;
}

// 将时间字符串转换为秒
const timeToSeconds = (timeStr: string): number => {
  // 处理 "00:00:00,000" 或 "00:00:00.000" 格式
  const parts = timeStr.replace(',', '.').split(':');
  if (parts.length !== 3) return 0;

  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  const seconds = parseFloat(parts[2]);

  return hours * 3600 + minutes * 60 + seconds;
};

// 从时间范围字符串中提取开始和结束时间（秒）
const parseTimeRange = (timeRange: string): { start: number; end: number } => {
  // 处理 "00:00:00,000 --> 00:00:00,000" 格式
  const times = timeRange.split(' --> ');
  if (times.length !== 2) return { start: 0, end: 0 };

  return {
    start: timeToSeconds(times[0]),
    end: timeToSeconds(times[1]),
  };
};

export const useSubtitles = (
  file: IFiles,
  open: boolean,
  taskType: string,
  formData: any,
) => {
  const { t } = useTranslation('home');
  const [mergedSubtitles, setMergedSubtitles] = useState<Subtitle[]>([]);
  const [videoPath, setVideoPath] = useState<string>('');
  const [currentSubtitleIndex, setCurrentSubtitleIndex] = useState(-1);
  const [videoInfo, setVideoInfo] = useState({ fileName: '', extension: '' });
  const [hasTranslationFile, setHasTranslationFile] = useState(false);

  // 是否需要显示翻译内容
  const shouldShowTranslation = taskType !== 'generateOnly';

  useEffect(() => {
    if (file && open) {
      loadFiles();
    }
  }, [file, open]);

  // 获取视频文件信息
  useEffect(() => {
    if (videoPath) {
      const fileName = path.basename(videoPath, path.extname(videoPath));
      const extension = path.extname(videoPath).replace('.', '');
      setVideoInfo({ fileName, extension });
    }
  }, [videoPath]);

  // 读取字幕文件
  const readSubtitleFile = async (filePath: string): Promise<Subtitle[]> => {
    try {
      const result: Subtitle[] = await window.ipc.invoke('readSubtitleFile', {
        filePath,
      });
      return result;
    } catch (error) {
      console.error('Error reading subtitle file:', error);
      return [];
    }
  };

  // 加载文件
  const loadFiles = async () => {
    try {
      // 获取文件路径
      const {
        filePath,
        srtFile,
        tempSrtFile,
        translatedSrtFile,
        tempTranslatedSrtFile,
      } = file;
      const directory = path.dirname(filePath);
      const fileName = path.basename(filePath, path.extname(filePath));

      // 如果不是字幕文件，直接使用作为视频文件
      if (!isSubtitleFile(filePath)) {
        setVideoPath(filePath);
      }

      // 确定原始字幕文件路径
      let originalSrtFilePath = null;
      let translatedSrtFilePath = null;

      // 根据任务类型确定使用哪个原始字幕文件
      if (taskType === 'generateOnly') {
        originalSrtFilePath =
          srtFile || path.join(directory, `${fileName}.srt`);
        setHasTranslationFile(false);
      } else {
        // 对于需要翻译的任务，优先使用临时原始字幕文件
        originalSrtFilePath =
          tempSrtFile || srtFile || path.join(directory, `${fileName}.srt`);

        // 翻译字幕直接使用tempTranslatedSrtFile
        if (tempTranslatedSrtFile) {
          translatedSrtFilePath = tempTranslatedSrtFile;
          setHasTranslationFile(true);
        } else if (translatedSrtFile) {
          translatedSrtFilePath = translatedSrtFile;
          setHasTranslationFile(true);
        }
      }

      console.log('Paths:', {
        originalSrtFilePath,
        translatedSrtFilePath,
      });

      // 读取原始字幕文件
      let originalSubtitles = [];
      let translatedSubtitles = [];

      if (originalSrtFilePath) {
        originalSubtitles = await readSubtitleFile(originalSrtFilePath);
        console.log('原始字幕:', originalSubtitles);
      }

      // 读取翻译字幕文件（如果存在）
      if (shouldShowTranslation && translatedSrtFilePath) {
        translatedSubtitles = await readSubtitleFile(translatedSrtFilePath);
        console.log('翻译字幕:', translatedSubtitles);
      }

      // 合并字幕，匹配相同的时间码
      if (originalSubtitles.length > 0) {
        // 创建翻译字幕的时间码映射，提高查找效率
        const translatedMap = new Map();
        translatedSubtitles.forEach((sub) => {
          translatedMap.set(sub.startEndTime, sub);
        });

        // 创建合并的字幕数据
        const merged = originalSubtitles.map((sub, index) => {
          // 直接从Map中获取对应时间码的翻译字幕
          const translated =
            translatedMap.get(sub.startEndTime) ||
            (index < translatedSubtitles.length
              ? translatedSubtitles[index]
              : null);

          // 从startEndTime解析出开始和结束时间（秒）
          const { start, end } = parseTimeRange(sub.startEndTime);

          return {
            ...sub,
            sourceContent: sub.content.join('\n'),
            targetContent: translated ? translated.content.join('\n') : '',
            isEditing: false,
            // 添加计算出的开始和结束时间（秒）
            startTimeInSeconds: start,
            endTimeInSeconds: end,
          };
        });

        console.log('合并后的字幕（包含时间戳）:', merged);
        setMergedSubtitles(merged);
      }
    } catch (error) {
      console.error('Error loading files:', error);
    }
  };

  // 更新字幕内容
  const handleSubtitleChange = (
    index: number,
    field: 'sourceContent' | 'targetContent',
    value: string,
  ) => {
    const newSubtitles = [...mergedSubtitles];
    newSubtitles[index][field] = value;
    // 更新content数组
    newSubtitles[index].content =
      field === 'sourceContent'
        ? value.split('\n')
        : newSubtitles[index].content;
    setMergedSubtitles(newSubtitles);
  };

  // 保存字幕文件
  const handleSave = async () => {
    try {
      // 获取文件路径
      const { srtFile, tempSrtFile, translatedSrtFile, tempTranslatedSrtFile } =
        file;

      // 保存原始字幕
      if (srtFile && formData.sourceSrtSaveOption !== 'noSave') {
        console.log('保存原始字幕', srtFile);
        window.ipc.invoke('saveSubtitleFile', {
          filePath: srtFile,
          subtitles: mergedSubtitles,
          contentType: 'source',
        });
      }
      if (tempSrtFile) {
        console.log('保存临时原始字幕', tempSrtFile);
        window.ipc.invoke('saveSubtitleFile', {
          filePath: tempSrtFile,
          subtitles: mergedSubtitles,
          contentType: 'source',
        });
      }

      // 保存翻译字幕（只在需要显示翻译内容且有翻译内容时）
      if (shouldShowTranslation) {
        // 保存到翻译字幕文件
        if (translatedSrtFile) {
          window.ipc.invoke('saveSubtitleFile', {
            filePath: translatedSrtFile,
            subtitles: mergedSubtitles,
            contentType: formData.translateContent,
          });
        }

        // 如果有指定的临时翻译文件且不同于主翻译文件，也保存一份
        if (tempTranslatedSrtFile) {
          window.ipc.invoke('saveSubtitleFile', {
            filePath: tempTranslatedSrtFile,
            subtitles: mergedSubtitles,
            contentType: 'onlyTranslate',
          });
        }
      }
      toast.success(t('subtitleSavedSuccess'));
    } catch (error) {
      console.error('Error saving subtitles:', error);
      toast.error(t('saveFailed'));
    }
  };

  // 计算字幕统计信息
  const getSubtitleStats = (): SubtitleStats => {
    const total = mergedSubtitles.length;
    const withTranslation = shouldShowTranslation
      ? mergedSubtitles.filter(
          (sub) => sub.targetContent && sub.targetContent.trim() !== '',
        ).length
      : 0;
    const percent =
      total > 0 && shouldShowTranslation
        ? Math.round((withTranslation / total) * 100)
        : 0;

    return { total, withTranslation, percent };
  };

  return {
    mergedSubtitles,
    setMergedSubtitles,
    videoPath,
    currentSubtitleIndex,
    setCurrentSubtitleIndex,
    videoInfo,
    hasTranslationFile,
    shouldShowTranslation,
    handleSubtitleChange,
    handleSave,
    getSubtitleStats,
  };
};
