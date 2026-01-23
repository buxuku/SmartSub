/**
 * 字幕合并状态管理 Hook
 * 封装所有业务逻辑，便于组件复用
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type {
  SubtitleStyle,
  MergeProgress,
  MergeStatus,
  VideoInfo,
  SubtitleInfo,
  MergeConfig,
} from '../../../../types/subtitleMerge';
import { DEFAULT_STYLE, STYLE_PRESETS } from '../constants';

/**
 * Hook 返回的状态和方法
 */
export interface UseSubtitleMergeReturn {
  // 文件状态
  videoPath: string | null;
  subtitlePath: string | null;
  videoInfo: VideoInfo | null;
  subtitleInfo: SubtitleInfo | null;

  // 样式状态
  style: SubtitleStyle;
  activePresetId: string | null;

  // 输出状态
  outputPath: string | null;

  // 进度状态
  progress: MergeProgress;
  status: MergeStatus;

  // 文件操作方法
  selectVideo: () => Promise<void>;
  selectSubtitle: () => Promise<void>;
  setVideoPath: (path: string) => Promise<void>;
  setSubtitlePath: (path: string) => Promise<void>;
  clearFiles: () => void;

  // 样式操作方法
  setStyle: (style: SubtitleStyle) => void;
  updateStyle: (updates: Partial<SubtitleStyle>) => void;
  applyPreset: (presetId: string) => void;
  resetStyle: () => void;

  // 输出操作方法
  selectOutputPath: () => Promise<void>;
  setOutputPath: (path: string) => void;

  // 合并操作方法
  startMerge: () => Promise<void>;
  canMerge: boolean;

  // 其他方法
  openOutputFolder: () => Promise<void>;
}

/**
 * Hook 配置选项
 */
export interface UseSubtitleMergeOptions {
  /** 初始视频路径 */
  initialVideoPath?: string;
  /** 初始字幕路径 */
  initialSubtitlePath?: string;
  /** 初始样式 */
  initialStyle?: SubtitleStyle;
  /** 进度回调 */
  onProgress?: (progress: MergeProgress) => void;
  /** 完成回调 */
  onComplete?: (outputPath: string) => void;
  /** 错误回调 */
  onError?: (error: string) => void;
}

/**
 * 字幕合并状态管理 Hook
 */
export function useSubtitleMerge(
  options: UseSubtitleMergeOptions = {},
): UseSubtitleMergeReturn {
  const {
    initialVideoPath,
    initialSubtitlePath,
    initialStyle,
    onProgress,
    onComplete,
    onError,
  } = options;

  // 文件状态
  const [videoPath, setVideoPathState] = useState<string | null>(
    initialVideoPath || null,
  );
  const [subtitlePath, setSubtitlePathState] = useState<string | null>(
    initialSubtitlePath || null,
  );
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [subtitleInfo, setSubtitleInfo] = useState<SubtitleInfo | null>(null);

  // 样式状态
  const [style, setStyleState] = useState<SubtitleStyle>(
    initialStyle || DEFAULT_STYLE,
  );
  const [activePresetId, setActivePresetId] = useState<string | null>(
    'classic',
  );

  // 输出状态
  const [outputPath, setOutputPathState] = useState<string | null>(null);

  // 进度状态
  const [progress, setProgress] = useState<MergeProgress>({
    percent: 0,
    timeMark: '',
    targetSize: 0,
    status: 'idle',
  });

  // 引用
  const isMountedRef = useRef(true);

  // 监听实时进度事件 (只更新进度百分比，不处理完成/错误状态)
  useEffect(() => {
    isMountedRef.current = true;

    const handleProgress = (progressData: MergeProgress) => {
      if (isMountedRef.current && progressData.status === 'processing') {
        setProgress(progressData);
        onProgress?.(progressData);
      }
    };

    const cleanup = window.ipc?.on('subtitleMerge:progress', handleProgress);

    return () => {
      isMountedRef.current = false;
      cleanup?.();
    };
  }, [onProgress]);

  // 加载视频信息
  const loadVideoInfo = useCallback(async (path: string) => {
    try {
      const result = await window.ipc.invoke('subtitleMerge:getVideoInfo', {
        videoPath: path,
      });
      if (result.success && result.data) {
        setVideoInfo(result.data);
        // 自动生成输出路径
        const outputResult = await window.ipc.invoke(
          'subtitleMerge:generateOutputPath',
          {
            videoPath: path,
            suffix: '_subtitled',
          },
        );
        if (outputResult.success && outputResult.data) {
          setOutputPathState(outputResult.data);
        }
      }
    } catch (error) {
      console.error('加载视频信息失败:', error);
    }
  }, []);

  // 加载字幕信息
  const loadSubtitleInfo = useCallback(async (path: string) => {
    try {
      const result = await window.ipc.invoke('subtitleMerge:getSubtitleInfo', {
        subtitlePath: path,
      });
      if (result.success && result.data) {
        setSubtitleInfo(result.data);
      }
    } catch (error) {
      console.error('加载字幕信息失败:', error);
    }
  }, []);

  // 选择视频文件
  const selectVideo = useCallback(async () => {
    try {
      const result = await window.ipc.invoke('selectFile', {
        type: 'video',
        title: '选择视频文件',
      });
      if (!result.canceled && result.filePath) {
        setVideoPathState(result.filePath);
        await loadVideoInfo(result.filePath);
      }
    } catch (error) {
      console.error('选择视频失败:', error);
    }
  }, [loadVideoInfo]);

  // 选择字幕文件
  const selectSubtitle = useCallback(async () => {
    try {
      const result = await window.ipc.invoke('selectFile', {
        type: 'subtitle',
        title: '选择字幕文件',
      });
      if (!result.canceled && result.filePath) {
        setSubtitlePathState(result.filePath);
        await loadSubtitleInfo(result.filePath);
      }
    } catch (error) {
      console.error('选择字幕失败:', error);
    }
  }, [loadSubtitleInfo]);

  // 设置视频路径
  const setVideoPath = useCallback(
    async (path: string) => {
      setVideoPathState(path);
      await loadVideoInfo(path);
    },
    [loadVideoInfo],
  );

  // 设置字幕路径
  const setSubtitlePath = useCallback(
    async (path: string) => {
      setSubtitlePathState(path);
      await loadSubtitleInfo(path);
    },
    [loadSubtitleInfo],
  );

  // 清空文件
  const clearFiles = useCallback(() => {
    setVideoPathState(null);
    setSubtitlePathState(null);
    setVideoInfo(null);
    setSubtitleInfo(null);
    setOutputPathState(null);
    setProgress({
      percent: 0,
      timeMark: '',
      targetSize: 0,
      status: 'idle',
    });
  }, []);

  // 设置完整样式
  const setStyle = useCallback((newStyle: SubtitleStyle) => {
    setStyleState(newStyle);
    setActivePresetId(null);
  }, []);

  // 更新部分样式
  const updateStyle = useCallback((updates: Partial<SubtitleStyle>) => {
    setStyleState((prev) => ({ ...prev, ...updates }));
    setActivePresetId(null);
  }, []);

  // 应用预设样式
  const applyPreset = useCallback((presetId: string) => {
    const preset = STYLE_PRESETS.find((p) => p.id === presetId);
    if (preset) {
      setStyleState(preset.style);
      setActivePresetId(presetId);
    }
  }, []);

  // 重置样式
  const resetStyle = useCallback(() => {
    setStyleState(DEFAULT_STYLE);
    setActivePresetId('classic');
  }, []);

  // 选择输出路径
  const selectOutputPath = useCallback(async () => {
    try {
      const result = await window.ipc.invoke('subtitleMerge:selectOutputPath', {
        defaultPath: outputPath,
      });
      if (result.success && result.data) {
        setOutputPathState(result.data);
      }
    } catch (error) {
      console.error('选择输出路径失败:', error);
    }
  }, [outputPath]);

  // 设置输出路径
  const setOutputPath = useCallback((path: string) => {
    setOutputPathState(path);
  }, []);

  // 开始合并
  const startMerge = useCallback(async () => {
    if (!videoPath || !subtitlePath || !outputPath) return;

    setProgress({
      percent: 0,
      timeMark: '',
      targetSize: 0,
      status: 'processing',
    });

    try {
      const config: MergeConfig = {
        videoPath,
        subtitlePath,
        outputPath,
        style,
      };
      const result = await window.ipc.invoke(
        'subtitleMerge:startMerge',
        config,
      );

      if (result.success) {
        // 合并成功
        setProgress({
          percent: 100,
          timeMark: '',
          targetSize: 0,
          status: 'completed',
        });
        onComplete?.(outputPath);
      } else {
        // 合并失败
        setProgress({
          percent: 0,
          timeMark: '',
          targetSize: 0,
          status: 'error',
          errorMessage: result.error,
        });
        onError?.(result.error || '合并失败');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '合并失败';
      setProgress({
        percent: 0,
        timeMark: '',
        targetSize: 0,
        status: 'error',
        errorMessage,
      });
      onError?.(errorMessage);
    }
  }, [videoPath, subtitlePath, outputPath, style, onComplete, onError]);

  // 打开输出文件夹
  const openOutputFolder = useCallback(async () => {
    if (!outputPath) return;
    try {
      await window.ipc.invoke('subtitleMerge:openOutputFolder', {
        filePath: outputPath,
      });
    } catch (error) {
      console.error('打开文件夹失败:', error);
    }
  }, [outputPath]);

  // 是否可以开始合并
  const canMerge = Boolean(
    videoPath && subtitlePath && outputPath && progress.status !== 'processing',
  );

  return {
    // 文件状态
    videoPath,
    subtitlePath,
    videoInfo,
    subtitleInfo,

    // 样式状态
    style,
    activePresetId,

    // 输出状态
    outputPath,

    // 进度状态
    progress,
    status: progress.status,

    // 文件操作方法
    selectVideo,
    selectSubtitle,
    setVideoPath,
    setSubtitlePath,
    clearFiles,

    // 样式操作方法
    setStyle,
    updateStyle,
    applyPreset,
    resetStyle,

    // 输出操作方法
    selectOutputPath,
    setOutputPath,

    // 合并操作方法
    startMerge,
    canMerge,

    // 其他方法
    openOutputFolder,
  };
}
