import { useState, useEffect, useCallback, useRef } from 'react';
import path from 'path';
import { isSubtitleFile } from 'lib/utils';
import { toast } from 'sonner';
import { useTranslation } from 'next-i18next';
import toWebVTT from 'srt-webvtt';
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

// 新增：播放器字幕轨道接口
export interface PlayerSubtitleTrack {
  kind: string;
  src: string;
  srcLang: string;
  label: string;
  default?: boolean;
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
  const [previousSubtitleIndex, setPreviousSubtitleIndex] = useState(-1);
  const [videoInfo, setVideoInfo] = useState({ fileName: '', extension: '' });
  const [hasTranslationFile, setHasTranslationFile] = useState(false);
  const [subtitleTracksForPlayer, setSubtitleTracksForPlayer] = useState<
    PlayerSubtitleTrack[]
  >([]);

  // 撤销/重做历史
  const [history, setHistory] = useState<Subtitle[][]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const maxHistoryLength = 50;

  // 记录编辑前的快照（用于失焦记录）
  const [editSnapshot, setEditSnapshot] = useState<Subtitle[] | null>(null);

  // 光标位置（用于拆分功能）
  const cursorPositionRef = useRef(0);

  // 是否需要显示翻译内容
  const shouldShowTranslation = taskType !== 'generateOnly';

  useEffect(() => {
    if (file && open) {
      loadFiles();
    }

    // 4. 管理 Object URL 的生命周期
    return () => {
      subtitleTracksForPlayer.forEach((track) => {
        if (track.src && track.src.startsWith('blob:')) {
          URL.revokeObjectURL(track.src);
        }
      });
      setSubtitleTracksForPlayer([]); // 清空轨道信息
    };
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
      let originalSrtPath: string | null | undefined = null;
      let translatedSrtPath: string | null | undefined = null;

      // 根据任务类型确定使用哪个原始字幕文件
      if (taskType === 'generateOnly') {
        originalSrtPath = srtFile || path.join(directory, `${fileName}.srt`);
        setHasTranslationFile(false);
      } else {
        // 对于需要翻译的任务，优先使用临时原始字幕文件
        originalSrtPath =
          tempSrtFile || srtFile || path.join(directory, `${fileName}.srt`);

        // 翻译字幕直接使用tempTranslatedSrtFile
        if (tempTranslatedSrtFile) {
          translatedSrtPath = tempTranslatedSrtFile;
          setHasTranslationFile(true);
        } else if (translatedSrtFile) {
          translatedSrtPath = translatedSrtFile;
          setHasTranslationFile(true);
        }
      }

      // 读取原始字幕文件
      let originalSubtitles = [];
      let translatedSubtitles = [];

      // 用于播放器的字幕轨道
      const playerTracks: PlayerSubtitleTrack[] = [];

      const createPlayerTrack = async (
        srtPath: string | null | undefined,
        language: string,
        isDefault?: boolean,
      ): Promise<PlayerSubtitleTrack | null> => {
        if (!srtPath) return null;
        try {
          const result = await window.ipc.invoke('readRawFileContent', {
            filePath: srtPath,
          });
          if (result.error || !result.content) {
            console.error(`无法读取字幕文件 ${srtPath}:`, result.error);
            toast.error(
              t('errorReadSubtitle', { file: path.basename(srtPath) }),
            );
            return null;
          }
          const srtContent = result.content;
          const srtBlob = new Blob([srtContent], { type: 'text/plain' });
          const vttUrl = await toWebVTT(srtBlob);
          return {
            kind: 'subtitles',
            src: vttUrl,
            srcLang: language,
            label: `(${language})`,
            default: isDefault,
          };
        } catch (error) {
          console.error(`转换字幕 ${srtPath} 到 VTT 失败:`, error);
          toast.error(t('errorConvertToVTT', { file: path.basename(srtPath) }));
          return null;
        }
      };

      if (originalSrtPath) {
        originalSubtitles = await readSubtitleFile(originalSrtPath);
        if (formData.sourceLanguage) {
          const track = await createPlayerTrack(
            originalSrtPath,
            formData.sourceLanguage,
            !shouldShowTranslation,
          );
          if (track) playerTracks.push(track);
        }
      }

      // 读取翻译字幕文件（如果存在）
      if (shouldShowTranslation && translatedSrtPath) {
        translatedSubtitles = await readSubtitleFile(translatedSrtPath);
        if (formData.targetLanguage) {
          const track = await createPlayerTrack(
            translatedSrtPath,
            formData.targetLanguage,
            true,
          );
          if (track) playerTracks.push(track);
        }
      }

      setSubtitleTracksForPlayer(playerTracks);

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

        setMergedSubtitles(merged);
      }
    } catch (error) {
      console.error('Error loading files:', error);
    }
  };

  // 更新字幕内容（带失焦记录支持）
  const handleSubtitleChange = (
    index: number,
    field: 'sourceContent' | 'targetContent',
    value: string,
  ) => {
    // 首次编辑时保存快照
    if (!editSnapshot) {
      setEditSnapshot(JSON.parse(JSON.stringify(mergedSubtitles)));
    }

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
        window.ipc.invoke('saveSubtitleFile', {
          filePath: srtFile,
          subtitles: mergedSubtitles,
          contentType: 'source',
        });
      }
      if (tempSrtFile) {
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

  // 检查字幕是否翻译失败
  const isTranslationFailed = (subtitle: Subtitle): boolean => {
    if (!shouldShowTranslation) return false;
    return (
      subtitle.sourceContent &&
      subtitle.sourceContent.trim() !== '' &&
      (!subtitle.targetContent || subtitle.targetContent.trim() === '')
    );
  };

  // 获取所有翻译失败的字幕索引
  const getFailedTranslationIndices = (): number[] => {
    if (!shouldShowTranslation) return [];
    return mergedSubtitles
      .map((subtitle, index) => (isTranslationFailed(subtitle) ? index : -1))
      .filter((index) => index !== -1);
  };

  // 导航到下一条翻译失败的字幕
  const goToNextFailedTranslation = (): void => {
    const failedIndices = getFailedTranslationIndices();
    if (failedIndices.length === 0) return;

    const nextIndex = failedIndices.find(
      (index) => index > currentSubtitleIndex,
    );
    if (nextIndex !== undefined) {
      setCurrentSubtitleIndex(nextIndex);
    } else {
      // 如果没有更后面的失败项，跳转到第一个失败项
      setCurrentSubtitleIndex(failedIndices[0]);
    }
  };

  // 导航到上一条翻译失败的字幕
  const goToPreviousFailedTranslation = (): void => {
    const failedIndices = getFailedTranslationIndices();
    if (failedIndices.length === 0) return;

    // 反向查找比当前索引小的失败项
    const previousIndex = failedIndices
      .slice()
      .reverse()
      .find((index) => index < currentSubtitleIndex);

    if (previousIndex !== undefined) {
      setCurrentSubtitleIndex(previousIndex);
    } else {
      // 如果没有更前面的失败项，跳转到最后一个失败项
      setCurrentSubtitleIndex(failedIndices[failedIndices.length - 1]);
    }
  };

  // ============ 编辑增强功能 ============

  // 秒数转时间戳字符串
  const secondsToTime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = (seconds % 60).toFixed(3);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.padStart(6, '0').replace('.', ',')}`;
  };

  // 保存到历史记录（用于撤销/重做）
  const pushToHistory = useCallback(
    (oldState: Subtitle[], newState: Subtitle[]) => {
      setHistory((prev) => {
        const newHistory = prev.slice(0, historyIndex + 1);
        if (newHistory.length === 0) {
          newHistory.push(JSON.parse(JSON.stringify(oldState)));
        }
        newHistory.push(JSON.parse(JSON.stringify(newState)));
        while (newHistory.length > maxHistoryLength) {
          newHistory.shift();
        }
        return newHistory;
      });
      setHistoryIndex((prev) => {
        if (prev === -1) return 1;
        return Math.min(prev + 1, maxHistoryLength - 1);
      });
    },
    [historyIndex],
  );

  // 更新字幕（带历史记录）
  const updateSubtitles = useCallback(
    (newSubtitles: Subtitle[]) => {
      pushToHistory(mergedSubtitles, newSubtitles);
      setMergedSubtitles(newSubtitles);
    },
    [mergedSubtitles, pushToHistory],
  );

  // 撤销
  const handleUndo = useCallback(() => {
    if (historyIndex > 0 && history.length > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      setMergedSubtitles(JSON.parse(JSON.stringify(history[newIndex])));
      setEditSnapshot(null);
    }
  }, [historyIndex, history]);

  // 重做
  const handleRedo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      setMergedSubtitles(JSON.parse(JSON.stringify(history[newIndex])));
      setEditSnapshot(null);
    }
  }, [historyIndex, history]);

  // 是否可以撤销/重做
  const canUndo = historyIndex > 0 && history.length > 1;
  const canRedo = historyIndex < history.length - 1 && historyIndex >= 0;

  // 失焦记录：当切换字幕时，如果有编辑过，保存到历史
  useEffect(() => {
    if (
      previousSubtitleIndex !== -1 &&
      previousSubtitleIndex !== currentSubtitleIndex &&
      editSnapshot
    ) {
      const hasChanged =
        JSON.stringify(editSnapshot) !== JSON.stringify(mergedSubtitles);
      if (hasChanged) {
        pushToHistory(editSnapshot, mergedSubtitles);
      }
      setEditSnapshot(null);
    }
    setPreviousSubtitleIndex(currentSubtitleIndex);
  }, [currentSubtitleIndex, editSnapshot, mergedSubtitles, pushToHistory]);

  // 合并字幕
  const handleMergeSubtitles = useCallback(
    (startIndex: number, endIndex: number) => {
      if (
        startIndex < 0 ||
        endIndex > mergedSubtitles.length ||
        startIndex >= endIndex
      )
        return;

      const toMerge = mergedSubtitles.slice(startIndex, endIndex);
      if (toMerge.length < 2) return;

      const mergedContent = toMerge
        .map((s) => s.sourceContent)
        .filter(Boolean)
        .join('\n');
      const mergedTarget = toMerge
        .map((s) => s.targetContent)
        .filter(Boolean)
        .join('\n');

      const startTime = toMerge[0].startTimeInSeconds || 0;
      const endTime = toMerge[toMerge.length - 1].endTimeInSeconds || 0;

      const merged: Subtitle = {
        ...toMerge[0],
        sourceContent: mergedContent,
        targetContent: mergedTarget,
        content: mergedContent.split('\n'),
        startEndTime: `${secondsToTime(startTime)} --> ${secondsToTime(endTime)}`,
        startTimeInSeconds: startTime,
        endTimeInSeconds: endTime,
      };

      const newSubtitles = [
        ...mergedSubtitles.slice(0, startIndex),
        merged,
        ...mergedSubtitles.slice(endIndex),
      ];

      newSubtitles.forEach((sub, idx) => {
        sub.id = String(idx + 1);
      });

      updateSubtitles(newSubtitles);
      toast.success(t('mergeSuccess') || '字幕已合并');
    },
    [mergedSubtitles, updateSubtitles, t],
  );

  // 拆分字幕（支持自定义时间拆分点）
  const handleSplitSubtitle = useCallback(
    (index: number, splitPoint: number, splitTime?: number) => {
      if (index < 0 || index >= mergedSubtitles.length) return;

      const subtitle = mergedSubtitles[index];
      const content = subtitle.sourceContent || '';
      const targetContent = subtitle.targetContent || '';

      if (content.length < 2) return;

      const content1 = content.slice(0, splitPoint);
      const content2 = content.slice(splitPoint);
      const targetSplitPoint = Math.floor(
        targetContent.length * (splitPoint / Math.max(content.length, 1)),
      );
      const target1 = targetContent.slice(0, targetSplitPoint);
      const target2 = targetContent.slice(targetSplitPoint);

      const startTime = subtitle.startTimeInSeconds || 0;
      const endTime = subtitle.endTimeInSeconds || 0;
      const midTime =
        splitTime !== undefined
          ? splitTime
          : startTime + (endTime - startTime) / 2;

      const sub1: Subtitle = {
        ...subtitle,
        sourceContent: content1,
        targetContent: target1,
        content: content1.split('\n'),
        startEndTime: `${secondsToTime(startTime)} --> ${secondsToTime(midTime)}`,
        endTimeInSeconds: midTime,
      };

      const sub2: Subtitle = {
        ...subtitle,
        id: String(index + 2),
        sourceContent: content2,
        targetContent: target2,
        content: content2.split('\n'),
        startEndTime: `${secondsToTime(midTime)} --> ${secondsToTime(endTime)}`,
        startTimeInSeconds: midTime,
      };

      const newSubtitles = [
        ...mergedSubtitles.slice(0, index),
        sub1,
        sub2,
        ...mergedSubtitles.slice(index + 1),
      ];

      newSubtitles.forEach((sub, idx) => {
        sub.id = String(idx + 1);
      });

      updateSubtitles(newSubtitles);
      toast.success(t('splitSuccess') || '字幕已拆分');
    },
    [mergedSubtitles, updateSubtitles, t],
  );

  // 更新光标位置
  const handleCursorPositionChange = useCallback((position: number) => {
    cursorPositionRef.current = position;
  }, []);

  // 获取当前光标位置
  const getCursorPosition = useCallback(() => {
    return cursorPositionRef.current;
  }, []);

  return {
    mergedSubtitles,
    setMergedSubtitles,
    updateSubtitles,
    videoPath,
    currentSubtitleIndex,
    setCurrentSubtitleIndex,
    videoInfo,
    hasTranslationFile,
    shouldShowTranslation,
    subtitleTracksForPlayer,
    handleSubtitleChange,
    handleSave,
    getSubtitleStats,
    // 翻译失败相关功能
    isTranslationFailed,
    getFailedTranslationIndices,
    goToNextFailedTranslation,
    goToPreviousFailedTranslation,
    // 编辑增强功能
    handleUndo,
    handleRedo,
    canUndo,
    canRedo,
    handleMergeSubtitles,
    handleSplitSubtitle,
    handleCursorPositionChange,
    getCursorPosition,
  };
};
