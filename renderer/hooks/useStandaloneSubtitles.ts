/**
 * 独立校对模式的字幕管理 Hook
 * 不依赖 IFiles，直接接收文件路径
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import path from 'path';
import { toast } from 'sonner';
import { useTranslation } from 'next-i18next';
import { Subtitle, SubtitleStats, PlayerSubtitleTrack } from './useSubtitles';
import { useSubtitleHistory, computeRangeDiff } from './useSubtitleHistory';

interface StandaloneSubtitlesConfig {
  videoPath?: string;
  sourceSubtitlePath?: string;
  targetSubtitlePath?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  finalTargetSubtitlePath?: string; // 目标翻译文件（用户配置格式，可能是双语）
  translateContent?: string; // 翻译内容格式设置
  proofreadDataFile?: string;
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

// id 归一化为「下标+1」：仅克隆 id 变化的行（合并/拆分/撤销重做后调用）
const renormalizeIds = (arr: Subtitle[]): Subtitle[] =>
  arr.map((sub, idx) => {
    const id = String(idx + 1);
    return sub.id === id ? sub : { ...sub, id };
  });

// 秒数转 SRT 时间戳字符串（HH:MM:SS,mmm）
const secondsToTime = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = (seconds % 60).toFixed(3);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.padStart(6, '0').replace('.', ',')}`;
};

// 时间相等容差（SRT 精度为毫秒）
const TIME_EPSILON = 0.0005;

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

  // 撤销/重做历史（命令模式：区间 diff 命令栈）
  const history = useSubtitleHistory();

  // 字幕数组的同步镜像：所有变更经 applySubtitles 落盘，
  // 命令构造/合并窗口等同步逻辑读它，避免依赖异步 setState
  const subtitlesRef = useRef<Subtitle[]>([]);

  // 逐字编辑合并窗口：同行同字段的连续输入合并为一条撤销命令
  const pendingEditRef = useRef<{
    index: number;
    field: 'sourceContent' | 'targetContent';
    before: Subtitle;
  } | null>(null);

  // 自上次保存以来是否有未保存修改
  const [isDirty, setIsDirty] = useState(false);

  // 光标位置（用于拆分功能）
  const cursorPositionRef = useRef(0);

  // 是否有翻译字幕
  const shouldShowTranslation = !!config.targetSubtitlePath;

  // 统一落盘：镜像 ref 与 state 同步更新
  const applySubtitles = useCallback((next: Subtitle[]) => {
    subtitlesRef.current = next;
    setMergedSubtitles(next);
  }, []);

  // 读取最新字幕数组（异步流程结束后回填用，避免拿到过期快照）
  const getSubtitles = useCallback(() => subtitlesRef.current, []);

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

  const readProofreadDataFile = async (
    filePath: string,
  ): Promise<Subtitle[]> => {
    try {
      const result: Subtitle[] = await window.ipc.invoke(
        'readProofreadDataFile',
        {
          filePath,
        },
      );
      return result;
    } catch (error) {
      console.error('Error reading proofread data file:', error);
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
      const result = await window.ipc.invoke('getSubtitleAsVtt', {
        filePath: srtPath,
      });
      if (result.error || !result.content) {
        console.error(`无法读取字幕文件 ${srtPath}:`, result.error);
        return null;
      }
      const vttBlob = new Blob([result.content], { type: 'text/vtt' });
      const vttUrl = URL.createObjectURL(vttBlob);
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
      const proofreadDataSubtitles = config.proofreadDataFile
        ? await readProofreadDataFile(config.proofreadDataFile)
        : [];
      const sourceSubtitles =
        proofreadDataSubtitles.length > 0
          ? proofreadDataSubtitles
          : await readSubtitleFile(config.sourceSubtitlePath);
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
      if (proofreadDataSubtitles.length > 0) {
        setHasTranslationFile(
          proofreadDataSubtitles.some(
            (sub) => sub.targetContent && sub.targetContent.trim() !== '',
          ),
        );
        if (config.targetSubtitlePath && config.targetLanguage) {
          const track = await createPlayerTrack(
            config.targetSubtitlePath,
            config.targetLanguage,
            true,
          );
          if (track) playerTracks.push(track);
        }
      } else if (config.targetSubtitlePath) {
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
          if (proofreadDataSubtitles.length > 0) {
            return { ...sub, isEditing: false };
          }

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

        applySubtitles(merged);
      }
      // 重新加载即新的编辑起点：清空历史与合并窗口
      history.reset();
      pendingEditRef.current = null;
      setIsDirty(false);
    } catch (error) {
      console.error('Error loading files:', error);
      toast.error(t('loadFileFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [config, shouldShowTranslation, t, applySubtitles, history.reset]);

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

  // 把合并窗口中的逐字编辑提交为一条撤销命令
  const flushPendingEdit = useCallback(() => {
    const pending = pendingEditRef.current;
    if (!pending) return;
    pendingEditRef.current = null;
    const after = subtitlesRef.current[pending.index];
    if (!after || after === pending.before) return;
    if ((after[pending.field] ?? '') === (pending.before[pending.field] ?? ''))
      return;
    history.push({
      start: pending.index,
      removed: [pending.before],
      inserted: [after],
    });
  }, [history.push]);

  // 更新字幕内容（行级克隆，连续输入合并为一条命令）
  const handleSubtitleChange = useCallback(
    (
      index: number,
      field: 'sourceContent' | 'targetContent',
      value: string,
    ) => {
      const current = subtitlesRef.current;
      const row = current[index];
      if (!row) return;

      const pending = pendingEditRef.current;
      // 换行或换字段：先提交上一个合并窗口
      if (pending && (pending.index !== index || pending.field !== field)) {
        flushPendingEdit();
      }
      if (!pendingEditRef.current) {
        pendingEditRef.current = { index, field, before: row };
      }

      const next = current.slice();
      next[index] = {
        ...row,
        [field]: value,
        content: field === 'sourceContent' ? value.split('\n') : row.content,
      };
      applySubtitles(next);
      setIsDirty(true);
    },
    [applySubtitles, flushPendingEdit],
  );

  // 保存字幕文件；返回是否全部写入成功
  const handleSave = async (): Promise<boolean> => {
    // 先把未提交的逐字编辑补入撤销历史，保证保存后仍可撤销
    flushPendingEdit();
    try {
      if (config.proofreadDataFile) {
        const outputs: { filePath?: string; contentType?: string }[] = [];
        const finalTargetPath = config.finalTargetSubtitlePath;

        if (config.sourceSubtitlePath) {
          outputs.push({
            filePath: config.sourceSubtitlePath,
            contentType: 'source',
          });
        }

        if (shouldShowTranslation) {
          if (
            config.targetSubtitlePath &&
            config.targetSubtitlePath !== finalTargetPath
          ) {
            outputs.push({
              filePath: config.targetSubtitlePath,
              contentType: 'onlyTranslate',
            });
          }
          outputs.push({
            filePath: finalTargetPath || config.targetSubtitlePath,
            contentType: finalTargetPath
              ? config.translateContent || 'onlyTranslate'
              : 'onlyTranslate',
          });
        }

        const result = await window.ipc.invoke('saveProofreadDataAndRender', {
          proofreadDataFile: config.proofreadDataFile,
          subtitles: mergedSubtitles,
          outputs: outputs.filter((output) => output.filePath),
        });

        if (result?.error) {
          console.error('Error saving proofread data:', result.error);
          toast.error(t('saveFailed'));
          return false;
        }

        setIsDirty(false);
        toast.success(t('subtitleSavedSuccess'));
        return true;
      }

      const results: { error?: string }[] = [];

      // 保存源字幕
      if (config.sourceSubtitlePath) {
        results.push(
          await window.ipc.invoke('saveSubtitleFile', {
            filePath: config.sourceSubtitlePath,
            subtitles: mergedSubtitles,
            contentType: 'source',
          }),
        );
      }

      // 保存翻译字幕（纯翻译内容到临时文件）
      if (config.targetSubtitlePath && shouldShowTranslation) {
        results.push(
          await window.ipc.invoke('saveSubtitleFile', {
            filePath: config.targetSubtitlePath,
            subtitles: mergedSubtitles,
            contentType: 'onlyTranslate',
          }),
        );
      }

      // 保存到目标翻译文件（按用户配置格式，可能是双语）
      if (config.finalTargetSubtitlePath && shouldShowTranslation) {
        const contentType = config.translateContent || 'onlyTranslate';
        results.push(
          await window.ipc.invoke('saveSubtitleFile', {
            filePath: config.finalTargetSubtitlePath,
            subtitles: mergedSubtitles,
            contentType,
          }),
        );
      }

      const failed = results.find((result) => result && result.error);
      if (failed) {
        console.error('Error saving subtitles:', failed.error);
        toast.error(t('saveFailed'));
        return false;
      }

      setIsDirty(false);
      toast.success(t('subtitleSavedSuccess'));
      return true;
    } catch (error) {
      console.error('Error saving subtitles:', error);
      toast.error(t('saveFailed'));
      return false;
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

  // 更新字幕（批量操作入口：计算最小区间 diff 入栈）
  const updateSubtitles = useCallback(
    (newSubtitles: Subtitle[]) => {
      flushPendingEdit();
      const diff = computeRangeDiff(subtitlesRef.current, newSubtitles);
      if (diff) history.push(diff);
      applySubtitles(newSubtitles);
      setIsDirty(true);
    },
    [applySubtitles, flushPendingEdit, history.push],
  );

  // 撤销：先提交合并窗口（保证「最后一次输入」也可撤销），再应用区间命令
  const handleUndo = useCallback(() => {
    flushPendingEdit();
    const next = history.undo(subtitlesRef.current);
    if (next) {
      applySubtitles(renormalizeIds(next));
      setIsDirty(true);
    }
  }, [applySubtitles, flushPendingEdit, history.undo]);

  // 重做：合并窗口若有内容会作为新命令清空 redo 分支（与主流编辑器一致）
  const handleRedo = useCallback(() => {
    flushPendingEdit();
    const next = history.redo(subtitlesRef.current);
    if (next) {
      applySubtitles(renormalizeIds(next));
      setIsDirty(true);
    }
  }, [applySubtitles, flushPendingEdit, history.redo]);

  // 是否可以撤销/重做（合并窗口中有未提交输入也算可撤销）
  const canUndo = history.canUndo || pendingEditRef.current !== null;
  const canRedo = history.canRedo;

  // 失焦记录：当切换字幕时，如果有编辑过，保存到历史
  useEffect(() => {
    if (
      previousSubtitleIndex !== -1 &&
      previousSubtitleIndex !== currentSubtitleIndex
    ) {
      flushPendingEdit();
    }
    setPreviousSubtitleIndex(currentSubtitleIndex);
  }, [currentSubtitleIndex, flushPendingEdit]);

  // 行内编辑起止时间：邻行钳制校验，通过则单行命令入栈；返回错误文案或 null
  const handleTimeChange = useCallback(
    (index: number, startSec: number, endSec: number): string | null => {
      const current = subtitlesRef.current;
      const row = current[index];
      if (!row) return null;

      if (!(startSec < endSec)) {
        return t('timeEditInvalidRange');
      }
      const prevRow = current[index - 1];
      if (
        prevRow &&
        startSec < (prevRow.endTimeInSeconds ?? 0) - TIME_EPSILON
      ) {
        return t('timeEditOverlapPrev');
      }
      const nextRow = current[index + 1];
      if (
        nextRow &&
        endSec > (nextRow.startTimeInSeconds ?? 0) + TIME_EPSILON
      ) {
        return t('timeEditOverlapNext');
      }

      // 无实际变化
      if (
        Math.abs((row.startTimeInSeconds ?? 0) - startSec) < TIME_EPSILON &&
        Math.abs((row.endTimeInSeconds ?? 0) - endSec) < TIME_EPSILON
      ) {
        return null;
      }

      flushPendingEdit();
      const updated: Subtitle = {
        ...row,
        startEndTime: `${secondsToTime(startSec)} --> ${secondsToTime(endSec)}`,
        startTimeInSeconds: startSec,
        endTimeInSeconds: endSec,
      };
      history.push({ start: index, removed: [row], inserted: [updated] });

      const next = current.slice();
      next[index] = updated;
      applySubtitles(next);
      setIsDirty(true);
      return null;
    },
    [applySubtitles, flushPendingEdit, history.push, t],
  );

  // 合并字幕（区间命令：N 行 → 1 行；id 由 renormalize 统一归位）
  const handleMergeSubtitles = useCallback(
    (startIndex: number, endIndex: number) => {
      const current = subtitlesRef.current;
      if (startIndex < 0 || endIndex > current.length || startIndex >= endIndex)
        return;

      const toMerge = current.slice(startIndex, endIndex);
      if (toMerge.length < 2) return;

      flushPendingEdit();

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

      history.push({ start: startIndex, removed: toMerge, inserted: [merged] });

      const next = current.slice();
      next.splice(startIndex, toMerge.length, merged);
      applySubtitles(renormalizeIds(next));
      setIsDirty(true);
      toast.success(t('mergeSuccess'));
    },
    [applySubtitles, flushPendingEdit, history.push, t],
  );

  // 删除单行字幕（区间命令：1 行 → 0 行；误删可通过撤销恢复）
  const handleDeleteSubtitle = useCallback(
    (index: number) => {
      const current = subtitlesRef.current;
      const row = current[index];
      if (!row) return;

      flushPendingEdit();
      history.push({ start: index, removed: [row], inserted: [] });

      const next = current.slice();
      next.splice(index, 1);
      applySubtitles(renormalizeIds(next));
      // 删除行后后续索引整体前移：当前行指针跟随钳制，避免越界或指向错行
      setCurrentSubtitleIndex((prev) => {
        if (prev < 0) return prev;
        if (prev === index) return Math.min(prev, next.length - 1);
        return prev > index ? prev - 1 : prev;
      });
      setIsDirty(true);
      toast.success(t('deleteSuccess'));
    },
    [applySubtitles, flushPendingEdit, history.push, t],
  );

  // 拆分字幕（区间命令：1 行 → 2 行；支持自定义时间拆分点）
  const handleSplitSubtitle = useCallback(
    (index: number, splitPoint: number, splitTime?: number) => {
      const current = subtitlesRef.current;
      if (index < 0 || index >= current.length) return;

      const subtitle = current[index];
      const content = subtitle.sourceContent || '';
      const targetContent = subtitle.targetContent || '';

      if (content.length < 2) return;

      flushPendingEdit();

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

      history.push({
        start: index,
        removed: [subtitle],
        inserted: [sub1, sub2],
      });

      const next = current.slice();
      next.splice(index, 1, sub1, sub2);
      applySubtitles(renormalizeIds(next));
      setIsDirty(true);
      toast.success(t('splitSuccess'));
    },
    [applySubtitles, flushPendingEdit, history.push, t],
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
    getSubtitles,
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
    isDirty,
    flushPendingEdit,
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
    handleDeleteSubtitle,
    handleTimeChange,
    // 光标位置
    handleCursorPositionChange,
    getCursorPosition,
  };
};
