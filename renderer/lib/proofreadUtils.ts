/**
 * 字幕校对相关的工具函数
 * 封装公共的字幕检测、创建 PendingFile 等逻辑
 */

import { v4 as uuidv4 } from 'uuid';
import path from 'path';

// 检测到的字幕信息
export interface DetectedSubtitle {
  filePath: string;
  type: 'source' | 'translated' | 'bilingual' | 'unknown';
  language?: string;
  confidence: number;
}

// 待校对文件项
export interface PendingFile {
  id: string;
  videoPath?: string;
  fileName: string;
  detectedSubtitles: DetectedSubtitle[];
  selectedSource?: string;
  selectedTarget?: string;
  proofreadDataFile?: string;
  finalTargetPath?: string;
  translateContent?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  status: 'pending' | 'proofreading' | 'completed';
  isSubtitleOnlyMode?: boolean; // 字幕导入模式，源字幕不可切换
}

// 支持的字幕类型
export type SubtitleType = 'source' | 'translated' | 'bilingual' | 'unknown';

/**
 * 按用户任务语向判定字幕是原文还是译文;语向不匹配时回退「en=原文」启发式。
 * 与 main/helpers/subtitleDetector.ts 的同名逻辑保持一致(进程边界无法共享模块)。
 */
export function classifySubtitleLang(
  lang: string | undefined | null,
  sourceLanguage?: string,
  targetLanguage?: string,
): 'source' | 'translated' | 'unknown' {
  if (!lang) return 'unknown';
  if (sourceLanguage && sourceLanguage !== 'auto' && lang === sourceLanguage)
    return 'source';
  if (targetLanguage && lang === targetLanguage) return 'translated';
  return lang === 'en' ? 'source' : 'translated';
}

/**
 * 从检测到的字幕列表中选择最佳的源字幕和翻译字幕
 */
export function selectBestSubtitles(
  detectedSubtitles: DetectedSubtitle[],
  excludeSource?: string,
): {
  bestSource: DetectedSubtitle | undefined;
  bestTarget: DetectedSubtitle | undefined;
} {
  // 源字幕优先选择 source 或 unknown 类型
  const sourceSubtitles = detectedSubtitles
    .filter((s) => s.type === 'source' || s.type === 'unknown')
    .sort((a, b) => b.confidence - a.confidence);

  // 翻译字幕优先选择 translated 类型
  const translatedSubtitles = detectedSubtitles
    .filter(
      (s) =>
        s.type === 'translated' &&
        (!excludeSource || s.filePath !== excludeSource),
    )
    .sort((a, b) => b.confidence - a.confidence);

  return {
    bestSource: sourceSubtitles[0],
    bestTarget: translatedSubtitles[0],
  };
}

/**
 * 从视频路径创建 PendingFile
 */
export async function createPendingFileFromVideo(
  videoPath: string,
): Promise<PendingFile> {
  // 检测关联的字幕
  const detectResult = await window.ipc.invoke('detectSubtitles', {
    videoPath,
  });

  const detectedSubtitles: DetectedSubtitle[] = detectResult.success
    ? detectResult.data.detectedSubtitles
    : [];

  const { bestSource, bestTarget } = selectBestSubtitles(detectedSubtitles);

  return {
    id: uuidv4(),
    videoPath,
    fileName: path.basename(videoPath),
    detectedSubtitles,
    selectedSource: bestSource?.filePath,
    selectedTarget: bestTarget?.filePath,
    sourceLanguage: bestSource?.language,
    targetLanguage: bestTarget?.language,
    status: 'pending',
  };
}

/**
 * 从字幕文件路径创建 PendingFile
 * @param sourceFilePath 源字幕文件路径
 * @param detectRelated 是否检测关联字幕（同目录下的其他字幕）
 */
export async function createPendingFileFromSubtitle(
  sourceFilePath: string,
  detectRelated: boolean = true,
): Promise<PendingFile> {
  const sourceFileName = path.basename(sourceFilePath);
  const sourceBaseName = sourceFileName.replace(/\.[^.]+$/, '');

  // 检测源字幕语言
  const sourceLangResult = await window.ipc.invoke('detectLanguage', {
    filePath: sourceFilePath,
  });
  const sourceLanguage = sourceLangResult.success
    ? sourceLangResult.data?.code
    : undefined;

  let detectedSubtitles: DetectedSubtitle[] = [];

  if (detectRelated) {
    // 使用检测逻辑获取同目录下的相关字幕
    const detectResult = await window.ipc.invoke('detectSubtitles', {
      videoPath: sourceFilePath.replace(/\.[^.]+$/, '.mp4'), // 伪造视频路径以复用检测逻辑
    });

    if (detectResult.success && detectResult.data.detectedSubtitles) {
      detectedSubtitles = detectResult.data.detectedSubtitles;
    }
  }

  // 确保源字幕在列表中（标记为 source，置信度 100%）
  const sourceInList = detectedSubtitles.find(
    (s) => s.filePath === sourceFilePath,
  );
  if (!sourceInList) {
    detectedSubtitles.unshift({
      filePath: sourceFilePath,
      type: 'source',
      language: sourceLanguage,
      confidence: 100,
    });
  } else {
    // 更新源字幕信息
    sourceInList.type = 'source';
    sourceInList.confidence = 100;
  }

  // 找到置信度最高的翻译字幕（排除源字幕）
  const translatedSubtitles = detectedSubtitles
    .filter((s) => s.filePath !== sourceFilePath && s.type !== 'source')
    .sort((a, b) => b.confidence - a.confidence);

  const bestTranslated = translatedSubtitles[0];

  return {
    id: uuidv4(),
    fileName: sourceBaseName,
    detectedSubtitles,
    selectedSource: sourceFilePath,
    selectedTarget: bestTranslated?.filePath,
    sourceLanguage,
    targetLanguage: bestTranslated?.language,
    status: 'pending',
    isSubtitleOnlyMode: true, // 标记为字幕导入模式
  };
}

/**
 * 获取字幕文件同目录下的可用字幕列表
 * @param subtitlePath 字幕文件路径
 * @param sourceLanguage 用户任务的源语言(用于语向判定,可选)
 * @param targetLanguage 用户任务的目标语言(用于语向判定,可选)
 */
export async function getAvailableSubtitles(
  subtitlePath: string,
  sourceLanguage?: string,
  targetLanguage?: string,
): Promise<DetectedSubtitle[]> {
  const dir = path.dirname(subtitlePath);

  const scanResult = await window.ipc.invoke('scanDirectorySubtitles', {
    directoryPath: dir,
  });

  if (!scanResult.success || !scanResult.data) {
    return [];
  }

  // 对每个字幕文件进行语言检测和置信度计算
  const detectedSubtitles = await Promise.all(
    scanResult.data.map(async (filePath: string) => {
      const langResult = await window.ipc.invoke('detectLanguage', {
        filePath,
      });
      const lang = langResult.success ? langResult.data?.code : undefined;

      // 计算置信度：与源字幕同名的文件置信度更高
      const sourceName = path
        .basename(subtitlePath, path.extname(subtitlePath))
        .replace(/\.\w{2,3}$/, '');
      const fileName = path
        .basename(filePath, path.extname(filePath))
        .replace(/\.\w{2,3}$/, '');
      const isRelated = sourceName === fileName;
      const confidence = isRelated ? 90 : 70;

      return {
        filePath,
        type: (filePath === subtitlePath
          ? 'source'
          : classifySubtitleLang(
              lang,
              sourceLanguage,
              targetLanguage,
            )) as SubtitleType,
        language: lang,
        confidence,
      };
    }),
  );

  return detectedSubtitles;
}

/**
 * 确保指定的字幕文件在列表中
 * @param subtitles 现有字幕列表
 * @param filePath 要确保存在的文件路径
 * @param type 字幕类型
 * @param language 语言代码
 * @returns 更新后的字幕列表
 */
export function ensureSubtitleInList(
  subtitles: DetectedSubtitle[],
  filePath: string | undefined,
  type: 'source' | 'translated',
  language?: string,
): DetectedSubtitle[] {
  if (!filePath) return subtitles;

  const exists = subtitles.some((s) => s.filePath === filePath);
  if (exists) return subtitles;

  return [
    ...subtitles,
    {
      filePath,
      type,
      language,
      confidence: 100, // 用户已选择的置信度设为最高
    },
  ];
}

/**
 * 从 ProofreadItem 加载 PendingFile（包括检测可用字幕）
 * @param item ProofreadItem 数据
 */
export async function loadPendingFileFromItem(item: {
  id: string;
  videoPath?: string;
  sourceSubtitlePath: string;
  targetSubtitlePath?: string;
  proofreadDataFile?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  status: 'pending' | 'in_progress' | 'completed';
  detectedSubtitles?: DetectedSubtitle[];
}): Promise<PendingFile> {
  let detectedSubtitles: DetectedSubtitle[] = [];
  const isSubtitleOnlyMode = !item.videoPath;

  // 如果任务中已保存了 detectedSubtitles，优先使用
  if (item.detectedSubtitles && item.detectedSubtitles.length > 0) {
    detectedSubtitles = item.detectedSubtitles.map((s) => ({
      filePath: s.filePath,
      type: s.type as 'source' | 'translated' | 'unknown',
      language: s.language,
      confidence: s.confidence,
    }));
  } else {
    // 否则重新检测
    if (item.videoPath) {
      // 有视频：使用视频检测
      const detectResult = await window.ipc.invoke('detectSubtitles', {
        videoPath: item.videoPath,
      });
      if (detectResult.success) {
        detectedSubtitles = detectResult.data.detectedSubtitles || [];
      }
    } else if (item.sourceSubtitlePath) {
      // 仅字幕：检测同目录下的其他字幕文件（按用户任务语向判定原文/译文）
      const userConfig = await window.ipc.invoke('getUserConfig');
      detectedSubtitles = await getAvailableSubtitles(
        item.sourceSubtitlePath,
        userConfig?.sourceLanguage,
        userConfig?.targetLanguage,
      );
    }
  }

  // 确保已选择的字幕在列表中
  detectedSubtitles = ensureSubtitleInList(
    detectedSubtitles,
    item.sourceSubtitlePath,
    'source',
    item.sourceLanguage,
  );
  detectedSubtitles = ensureSubtitleInList(
    detectedSubtitles,
    item.targetSubtitlePath,
    'translated',
    item.targetLanguage,
  );

  return {
    id: item.id,
    videoPath: item.videoPath,
    fileName: item.videoPath
      ? path.basename(item.videoPath)
      : path.basename(item.sourceSubtitlePath),
    detectedSubtitles,
    selectedSource: item.sourceSubtitlePath,
    selectedTarget: item.targetSubtitlePath,
    proofreadDataFile: item.proofreadDataFile,
    sourceLanguage: item.sourceLanguage,
    targetLanguage: item.targetLanguage,
    status: item.status === 'completed' ? 'completed' : 'pending',
    isSubtitleOnlyMode,
  };
}

/**
 * 将 PendingFile 转换为保存格式（用于创建/更新任务）
 */
export function pendingFileToSaveFormat(file: PendingFile): {
  id: string;
  videoPath?: string;
  sourceSubtitlePath: string;
  targetSubtitlePath?: string;
  proofreadDataFile?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  detectedSubtitles: DetectedSubtitle[];
  status: 'pending' | 'in_progress' | 'completed';
} {
  // 将 PendingFile 的 status 映射到 ProofreadItem 的 status
  const itemStatus =
    file.status === 'completed'
      ? 'completed'
      : file.status === 'proofreading'
        ? 'in_progress'
        : 'pending';

  return {
    id: file.id, // 保留原始 ID
    videoPath: file.videoPath,
    sourceSubtitlePath: file.selectedSource || '',
    targetSubtitlePath: file.selectedTarget,
    proofreadDataFile: file.proofreadDataFile,
    sourceLanguage: file.sourceLanguage,
    targetLanguage: file.targetLanguage,
    detectedSubtitles: file.detectedSubtitles.map((s) => ({
      filePath: s.filePath,
      type: s.type,
      language: s.language,
      confidence: s.confidence,
    })),
    status: itemStatus,
  };
}
