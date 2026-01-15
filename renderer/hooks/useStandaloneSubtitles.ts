/**
 * 独立校对模式的字幕管理 Hook
 * 不依赖 IFiles，直接接收文件路径
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import path from 'path';
import { toast } from 'sonner';
import { useTranslation } from 'next-i18next';
import toWebVTT from 'srt-webvtt';
import { Subtitle, SubtitleStats, PlayerSubtitleTrack } from './useSubtitles';

interface StandaloneSubtitlesConfig {
  videoPath?: string;
  sourceSubtitlePath?: string;
  targetSubtitlePath?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  finalTargetSubtitlePath?: string; // 目标翻译文件（用户配置格式，可能是双语）
  translateContent?: string; // 翻译内容格式设置
}

// 将时间字符串转换为秒
const timeToSeconds = (timeStr: string): number => {
  const parts = timeStr.replace(',', '.').split(':');
  if (parts.length !== 3) return 0;
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  const seconds = parseFloat(parts[2]);
  return hours * 3600 + minutes * 60 + seconds;
};

// 从时间范围字符串中提取开始和结束时间
const parseTimeRange = (timeRange: string): { start: number; end: number } => {
  const times = timeRange.split(' --> ');
  if (times.length !== 2) return { start: 0, end: 0 };
  return {
    start: timeToSeconds(times[0]),
    end: timeToSeconds(times[1]),
  };
};

export const useStandaloneSubtitles = (
  config: StandaloneSubtitlesConfig,
  isOpen: boolean,
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
  const [isLoading, setIsLoading] = useState(false);

  // 撤销/重做历史
  const [history, setHistory] = useState<Subtitle[][]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const maxHistoryLength = 50;

  // 记录编辑前的快照（用于失焦记录）
  const [editSnapshot, setEditSnapshot] = useState<Subtitle[] | null>(null);

  // 光标位置（用于拆分功能）
  const cursorPositionRef = useRef(0);

  // 是否有翻译字幕
  const shouldShowTranslation = !!config.targetSubtitlePath;

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

  // 创建播放器字幕轨道
  const createPlayerTrack = async (
    srtPath: string | undefined,
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
      console.error(`转换字幕到 VTT 失败:`, error);
      return null;
    }
  };

  // 加载文件
  const loadFiles = useCallback(async () => {
    if (!config.sourceSubtitlePath) return;

    setIsLoading(true);
    try {
      // 设置视频路径
      if (config.videoPath) {
        setVideoPath(config.videoPath);
      }

      const playerTracks: PlayerSubtitleTrack[] = [];

      // 读取源字幕
      const sourceSubtitles = await readSubtitleFile(config.sourceSubtitlePath);
      if (config.sourceLanguage) {
        const track = await createPlayerTrack(
          config.sourceSubtitlePath,
          config.sourceLanguage,
          !shouldShowTranslation,
        );
        if (track) playerTracks.push(track);
      }

      // 读取翻译字幕
      let translatedSubtitles: Subtitle[] = [];
      if (config.targetSubtitlePath) {
        translatedSubtitles = await readSubtitleFile(config.targetSubtitlePath);
        setHasTranslationFile(translatedSubtitles.length > 0);

        if (config.targetLanguage) {
          const track = await createPlayerTrack(
            config.targetSubtitlePath,
            config.targetLanguage,
            true,
          );
          if (track) playerTracks.push(track);
        }
      }

      setSubtitleTracksForPlayer(playerTracks);

      // 合并字幕
      if (sourceSubtitles.length > 0) {
        const translatedMap = new Map();
        translatedSubtitles.forEach((sub) => {
          translatedMap.set(sub.startEndTime, sub);
        });

        const merged = sourceSubtitles.map((sub, index) => {
          const translated =
            translatedMap.get(sub.startEndTime) ||
            (index < translatedSubtitles.length
              ? translatedSubtitles[index]
              : null);

          const { start, end } = parseTimeRange(sub.startEndTime);

          return {
            ...sub,
            sourceContent: sub.content.join('\n'),
            targetContent: translated ? translated.content.join('\n') : '',
            isEditing: false,
            startTimeInSeconds: start,
            endTimeInSeconds: end,
          };
        });

        setMergedSubtitles(merged);
      }
    } catch (error) {
      console.error('Error loading files:', error);
      toast.error(t('loadFileFailed') || '加载文件失败');
    } finally {
      setIsLoading(false);
    }
  }, [config, shouldShowTranslation, t]);

  // 加载文件
  useEffect(() => {
    if (isOpen && config.sourceSubtitlePath) {
      loadFiles();
    }

    // 清理 Object URL
    return () => {
      subtitleTracksForPlayer.forEach((track) => {
        if (track.src && track.src.startsWith('blob:')) {
          URL.revokeObjectURL(track.src);
        }
      });
    };
  }, [isOpen, config.sourceSubtitlePath, config.targetSubtitlePath]);

  // 更新视频信息
  useEffect(() => {
    if (videoPath) {
      const fileName = path.basename(videoPath, path.extname(videoPath));
      const extension = path.extname(videoPath).replace('.', '');
      setVideoInfo({ fileName, extension });
    } else if (config.sourceSubtitlePath) {
      const fileName = path.basename(
        config.sourceSubtitlePath,
        path.extname(config.sourceSubtitlePath),
      );
      setVideoInfo({ fileName, extension: '' });
    }
  }, [videoPath, config.sourceSubtitlePath]);

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
    newSubtitles[index].content =
      field === 'sourceContent'
        ? value.split('\n')
        : newSubtitles[index].content;
    setMergedSubtitles(newSubtitles);
  };

  // 保存字幕文件
  const handleSave = async () => {
    try {
      // 保存源字幕
      if (config.sourceSubtitlePath) {
        await window.ipc.invoke('saveSubtitleFile', {
          filePath: config.sourceSubtitlePath,
          subtitles: mergedSubtitles,
          contentType: 'source',
        });
      }

      // 保存翻译字幕（纯翻译内容到临时文件）
      if (config.targetSubtitlePath && shouldShowTranslation) {
        await window.ipc.invoke('saveSubtitleFile', {
          filePath: config.targetSubtitlePath,
          subtitles: mergedSubtitles,
          contentType: 'onlyTranslate',
        });
      }

      // 保存到目标翻译文件（按用户配置格式，可能是双语）
      if (config.finalTargetSubtitlePath && shouldShowTranslation) {
        const contentType = config.translateContent || 'onlyTranslate';
        await window.ipc.invoke('saveSubtitleFile', {
          filePath: config.finalTargetSubtitlePath,
          subtitles: mergedSubtitles,
          contentType,
        });
      }

      toast.success(t('subtitleSavedSuccess') || '字幕保存成功');
    } catch (error) {
      console.error('Error saving subtitles:', error);
      toast.error(t('saveFailed') || '保存失败');
    }
  };

  // 字幕统计
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

  // 检查翻译是否失败
  const isTranslationFailed = (subtitle: Subtitle): boolean => {
    if (!shouldShowTranslation) return false;
    return (
      !!subtitle.sourceContent &&
      subtitle.sourceContent.trim() !== '' &&
      (!subtitle.targetContent || subtitle.targetContent.trim() === '')
    );
  };

  // 获取翻译失败的索引
  const getFailedTranslationIndices = (): number[] => {
    if (!shouldShowTranslation) return [];
    return mergedSubtitles
      .map((subtitle, index) => (isTranslationFailed(subtitle) ? index : -1))
      .filter((index) => index !== -1);
  };

  // 导航到下一条失败的翻译
  const goToNextFailedTranslation = (): void => {
    const failedIndices = getFailedTranslationIndices();
    if (failedIndices.length === 0) return;
    const nextIndex = failedIndices.find(
      (index) => index > currentSubtitleIndex,
    );
    if (nextIndex !== undefined) {
      setCurrentSubtitleIndex(nextIndex);
    } else {
      setCurrentSubtitleIndex(failedIndices[0]);
    }
  };

  // 导航到上一条失败的翻译
  const goToPreviousFailedTranslation = (): void => {
    const failedIndices = getFailedTranslationIndices();
    if (failedIndices.length === 0) return;
    const previousIndex = failedIndices
      .slice()
      .reverse()
      .find((index) => index < currentSubtitleIndex);
    if (previousIndex !== undefined) {
      setCurrentSubtitleIndex(previousIndex);
    } else {
      setCurrentSubtitleIndex(failedIndices[failedIndices.length - 1]);
    }
  };

  // 保存到历史记录（用于撤销/重做）
  // 历史数组存储状态快照，historyIndex 指向当前状态
  const pushToHistory = useCallback(
    (oldState: Subtitle[], newState: Subtitle[]) => {
      setHistory((prev) => {
        // 如果当前不在历史末尾，移除后面的记录
        const newHistory = prev.slice(0, historyIndex + 1);
        // 如果历史为空，先添加旧状态
        if (newHistory.length === 0) {
          newHistory.push(JSON.parse(JSON.stringify(oldState)));
        }
        // 添加新状态
        newHistory.push(JSON.parse(JSON.stringify(newState)));
        // 限制历史长度
        while (newHistory.length > maxHistoryLength) {
          newHistory.shift();
        }
        return newHistory;
      });
      setHistoryIndex((prev) => {
        // 如果是第一次添加，从-1跳到1（包含初始状态0和新状态1）
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
      // 清除编辑快照，避免干扰
      setEditSnapshot(null);
    }
  }, [historyIndex, history]);

  // 重做
  const handleRedo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      setMergedSubtitles(JSON.parse(JSON.stringify(history[newIndex])));
      // 清除编辑快照，避免干扰
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
      // 检查是否有实际变化
      const hasChanged =
        JSON.stringify(editSnapshot) !== JSON.stringify(mergedSubtitles);
      if (hasChanged) {
        // 保存到历史（编辑前 -> 编辑后）
        pushToHistory(editSnapshot, mergedSubtitles);
      }
      // 清除快照
      setEditSnapshot(null);
    }
    setPreviousSubtitleIndex(currentSubtitleIndex);
  }, [currentSubtitleIndex, editSnapshot, mergedSubtitles, pushToHistory]);

  // 秒数转时间戳字符串
  const secondsToTime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = (seconds % 60).toFixed(3);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.padStart(6, '0').replace('.', ',')}`;
  };

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

      // 合并内容
      const mergedContent = toMerge
        .map((s) => s.sourceContent)
        .filter(Boolean)
        .join('\n');
      const mergedTarget = toMerge
        .map((s) => s.targetContent)
        .filter(Boolean)
        .join('\n');

      // 使用第一条的开始时间和最后一条的结束时间
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

      // 重新编号
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

      // 计算拆分后的内容
      const content1 = content.slice(0, splitPoint);
      const content2 = content.slice(splitPoint);
      const targetSplitPoint = Math.floor(
        targetContent.length * (splitPoint / Math.max(content.length, 1)),
      );
      const target1 = targetContent.slice(0, targetSplitPoint);
      const target2 = targetContent.slice(targetSplitPoint);

      // 计算拆分后的时间（支持自定义时间拆分点）
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

      // 重新编号
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
    isLoading,
    handleSubtitleChange,
    handleSave,
    getSubtitleStats,
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
    // 光标位置
    handleCursorPositionChange,
    getCursorPosition,
  };
};
