/**
 * 字幕校对相关类型定义
 */

// 检测到的字幕类型
export type DetectedSubtitleType =
  | 'source'
  | 'translated'
  | 'bilingual'
  | 'unknown';

// 检测到的字幕信息
export interface DetectedSubtitle {
  type: DetectedSubtitleType;
  filePath: string;
  language?: string;
  confidence: number; // 匹配置信度 0-100
}

// 字幕检测结果
export interface SubtitleDetectionResult {
  videoFile: string;
  detectedSubtitles: DetectedSubtitle[];
}

// 字幕匹配规则
export interface SubtitleMatchRule {
  id: string;
  name: string;
  sourcePattern: string;
  targetPattern: string;
  priority: number;
  isDefault?: boolean;
}

// 字幕匹配结果
export interface SubtitleMatchResult {
  baseName: string;
  source?: string;
  target?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
}

// ============ 批量校对任务相关 ============

// 单个校对项目（一个视频/字幕对）
export interface ProofreadItem {
  id: string;
  videoPath?: string;
  sourceSubtitlePath: string;
  targetSubtitlePath?: string;
  sourceLanguage?: string; // 自动检测的语言
  targetLanguage?: string;
  lastPosition: number; // 上次校对到的字幕索引
  totalCount: number; // 总字幕数
  modifiedCount: number; // 修改次数
  status: 'pending' | 'in_progress' | 'completed';
  // 可选字幕列表（包含检测到的和用户上传的）
  detectedSubtitles?: DetectedSubtitle[];
}

// 校对任务（包含多个项目）
export interface ProofreadTask {
  id: string;
  name: string; // 任务名称，默认取第一个文件名
  createdAt: number;
  updatedAt: number;
  items: ProofreadItem[]; // 包含的校对项目
  currentItemIndex: number; // 当前正在校对的项目索引
  status: 'in_progress' | 'completed';
}

// 兼容旧版本的历史记录（将被迁移）
export interface ProofreadHistory {
  id: string;
  createdAt: number;
  updatedAt: number;
  videoPath?: string;
  sourceSubtitlePath: string;
  targetSubtitlePath?: string;
  sourceLanguage: string;
  targetLanguage: string;
  lastPosition: number;
  modifiedCount: number;
  totalCount: number;
  status: 'in_progress' | 'completed';
  displayName?: string;
}

// 独立校对模式的字幕配置
export interface StandaloneSubtitleConfig {
  videoPath?: string;
  sourceSubtitlePath: string;
  targetSubtitlePath?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
}

// 语言检测结果
export interface LanguageDetectionResult {
  code: string; // ISO 639-1 代码
  name: string; // 语言名称
  confidence: number; // 置信度
}
