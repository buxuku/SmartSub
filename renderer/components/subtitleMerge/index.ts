/**
 * 字幕合并模块导出
 */

// 主面板组件
export { default as SubtitleMergePanel } from './SubtitleMergePanel';

// 子组件
export { default as FileSelector } from './FileSelector';
export { default as StylePresets } from './StylePresets';
export { default as BasicStyleSettings } from './BasicStyleSettings';
export { default as AdvancedStyleSettings } from './AdvancedStyleSettings';
export { default as AlignmentSelector } from './AlignmentSelector';
export { default as VideoPreview } from './VideoPreview';
export { default as SubtitlePreviewOverlay } from './SubtitlePreviewOverlay';
export { default as MergeButton } from './MergeButton';

// Hooks
export { useSubtitleMerge } from './hooks/useSubtitleMerge';
export type {
  UseSubtitleMergeReturn,
  UseSubtitleMergeOptions,
} from './hooks/useSubtitleMerge';

// 常量
export * from './constants';

// 工具函数
export * from './utils/styleUtils';
