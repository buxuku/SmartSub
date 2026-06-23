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
  MergeOutputMode,
  VideoQuality,
} from '../../../../types/subtitleMerge';
import {
  getDefaultStyle,
  getPlatformDefaultFont,
  STYLE_PRESETS,
} from '../constants';

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
  outputMode: MergeOutputMode;
  videoQuality: VideoQuality;

  // 进度状态
  progress: MergeProgress;
  status: MergeStatus;

  // 文件操作方法
  selectVideo: () => Promise<void>;
  selectSubtitle: () => Promise<void>;
  setVideoPath: (path: string) => Promise<void>;
  setSubtitlePath: (path: string) => Promise<void>;
  clearFiles: () => void;
  clearVideo: () => void;
  clearSubtitle: () => void;

  // 样式操作方法
  setStyle: (style: SubtitleStyle) => void;
  updateStyle: (updates: Partial<SubtitleStyle>) => void;
  applyPreset: (presetId: string) => void;
  resetStyle: () => void;

  // 输出操作方法
  selectOutputPath: () => Promise<void>;
  setOutputPath: (path: string) => void;
  setOutputMode: (mode: MergeOutputMode) => void;
  setVideoQuality: (quality: VideoQuality) => void;

  // 合并操作方法
  startMerge: () => Promise<void>;
  cancelMerge: () => Promise<void>;
  isCancelling: boolean;
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
    () => initialStyle || getDefaultStyle(),
  );
  const [activePresetId, setActivePresetId] = useState<string | null>(
    'classic',
  );

  // 输出状态
  const [outputPath, setOutputPathState] = useState<string | null>(null);
  const [outputMode, setOutputModeState] =
    useState<MergeOutputMode>('hardcode');
  // 烧录画质，默认原画质（CRF18），尽量贴近源文件画质（issue #331）
  const [videoQuality, setVideoQualityState] =
    useState<VideoQuality>('original');
  // 供异步回调读取最新输出方式（生成默认路径时按模式定扩展名）
  const outputModeRef = useRef<MergeOutputMode>('hardcode');
  outputModeRef.current = outputMode;

  // 软字幕封装固定输出 .mkv；切回烧录恢复视频原扩展名
  const applyModeExtension = useCallback(
    (path: string, mode: MergeOutputMode, currentVideoPath: string | null) => {
      if (mode === 'softmux') {
        return path.replace(/\.[^./\\]+$/, '.mkv');
      }
      const videoExtMatch = currentVideoPath?.match(/(\.[^./\\]+)$/);
      return videoExtMatch
        ? path.replace(/\.[^./\\]+$/, videoExtMatch[1])
        : path;
    },
    [],
  );

  // 进度状态
  const [progress, setProgress] = useState<MergeProgress>({
    percent: 0,
    timeMark: '',
    targetSize: 0,
    status: 'idle',
  });
  const [isCancelling, setIsCancelling] = useState(false);

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
  const loadVideoInfo = useCallback(
    async (path: string) => {
      try {
        const result = await window.ipc.invoke('subtitleMerge:getVideoInfo', {
          videoPath: path,
        });
        if (result.success && result.data) {
          setVideoInfo(result.data);
        }
      } catch (error) {
        console.error('加载视频信息失败:', error);
      }
      // 只要选了视频就生成默认输出路径（不依赖视频信息读取成功）
      try {
        const outputResult = await window.ipc.invoke(
          'subtitleMerge:generateOutputPath',
          {
            videoPath: path,
            suffix: '_subtitled',
          },
        );
        if (outputResult.success && outputResult.data) {
          setOutputPathState(
            applyModeExtension(outputResult.data, outputModeRef.current, path),
          );
        }
      } catch (error) {
        console.error('生成默认输出路径失败:', error);
      }
    },
    [applyModeExtension],
  );

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

  // 预填路径（如从任务完成横幅跳转）需要主动加载文件信息
  useEffect(() => {
    if (initialVideoPath) {
      loadVideoInfo(initialVideoPath);
    }
    if (initialSubtitlePath) {
      loadSubtitleInfo(initialSubtitlePath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 换文件后旧的合成结果不再对应当前输入，复位完成/错误状态
  const resetStaleProgress = useCallback(() => {
    setProgress((prev) =>
      prev.status === 'completed' || prev.status === 'error'
        ? { percent: 0, timeMark: '', targetSize: 0, status: 'idle' }
        : prev,
    );
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
        resetStaleProgress();
        await loadVideoInfo(result.filePath);
      }
    } catch (error) {
      console.error('选择视频失败:', error);
    }
  }, [loadVideoInfo, resetStaleProgress]);

  // 选择字幕文件
  const selectSubtitle = useCallback(async () => {
    try {
      const result = await window.ipc.invoke('selectFile', {
        type: 'subtitle',
        title: '选择字幕文件',
      });
      if (!result.canceled && result.filePath) {
        setSubtitlePathState(result.filePath);
        resetStaleProgress();
        await loadSubtitleInfo(result.filePath);
      }
    } catch (error) {
      console.error('选择字幕失败:', error);
    }
  }, [loadSubtitleInfo, resetStaleProgress]);

  // 设置视频路径
  const setVideoPath = useCallback(
    async (path: string) => {
      setVideoPathState(path);
      resetStaleProgress();
      await loadVideoInfo(path);
    },
    [loadVideoInfo, resetStaleProgress],
  );

  // 设置字幕路径
  const setSubtitlePath = useCallback(
    async (path: string) => {
      setSubtitlePathState(path);
      resetStaleProgress();
      await loadSubtitleInfo(path);
    },
    [loadSubtitleInfo, resetStaleProgress],
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

  // 单独清除视频：输出路径派生自视频一并清除；合成结果不再对应，进度复位
  const clearVideo = useCallback(() => {
    setVideoPathState(null);
    setVideoInfo(null);
    setOutputPathState(null);
    setProgress({
      percent: 0,
      timeMark: '',
      targetSize: 0,
      status: 'idle',
    });
  }, []);

  // 单独清除字幕
  const clearSubtitle = useCallback(() => {
    setSubtitlePathState(null);
    setSubtitleInfo(null);
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
      // classic 预设字体跟随平台，避免 Arial 渲染不了 CJK
      const nextStyle =
        preset.id === 'classic'
          ? { ...preset.style, fontName: getPlatformDefaultFont() }
          : preset.style;
      setStyleState(nextStyle);
      setActivePresetId(presetId);
    }
  }, []);

  // 重置样式
  const resetStyle = useCallback(() => {
    setStyleState(getDefaultStyle());
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

  // 设置烧录画质（仅 hardcode 生效）
  const setVideoQuality = useCallback((quality: VideoQuality) => {
    setVideoQualityState(quality);
  }, []);

  // 切换输出方式（联动输出扩展名；旧合成结果不再对应，复位状态）
  const setOutputMode = useCallback(
    (mode: MergeOutputMode) => {
      setOutputModeState(mode);
      setOutputPathState((prev) =>
        prev ? applyModeExtension(prev, mode, videoPath) : prev,
      );
      resetStaleProgress();
    },
    [applyModeExtension, videoPath, resetStaleProgress],
  );

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
        outputMode,
        videoQuality,
      };
      const result = await window.ipc.invoke(
        'subtitleMerge:startMerge',
        config,
      );

      if (result.success && result.cancelled) {
        // 用户取消：静默复位，不算失败
        setProgress({
          percent: 0,
          timeMark: '',
          targetSize: 0,
          status: 'idle',
        });
      } else if (result.success) {
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
    } finally {
      setIsCancelling(false);
    }
  }, [
    videoPath,
    subtitlePath,
    outputPath,
    style,
    outputMode,
    videoQuality,
    onComplete,
    onError,
  ]);

  // 取消合成
  const cancelMerge = useCallback(async () => {
    if (progress.status !== 'processing' || isCancelling) return;
    setIsCancelling(true);
    try {
      await window.ipc.invoke('subtitleMerge:cancelMerge');
      // 复位由 startMerge 的 cancelled 分支完成
    } catch (error) {
      console.error('取消合成失败:', error);
      setIsCancelling(false);
    }
  }, [progress.status, isCancelling]);

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
    outputMode,
    videoQuality,

    // 进度状态
    progress,
    status: progress.status,

    // 文件操作方法
    selectVideo,
    selectSubtitle,
    setVideoPath,
    setSubtitlePath,
    clearFiles,
    clearVideo,
    clearSubtitle,

    // 样式操作方法
    setStyle,
    updateStyle,
    applyPreset,
    resetStyle,

    // 输出操作方法
    selectOutputPath,
    setOutputPath,
    setOutputMode,
    setVideoQuality,

    // 合并操作方法
    startMerge,
    cancelMerge,
    isCancelling,
    canMerge,

    // 其他方法
    openOutputFolder,
  };
}
