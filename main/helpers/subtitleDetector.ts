/**
 * 字幕文件检测器
 * 负责检测视频对应的字幕文件，以及根据规则匹配字幕文件对
 */

import path from 'path';
import fs from 'fs-extra';
import {
  DetectedSubtitle,
  SubtitleDetectionResult,
  SubtitleMatchResult,
} from '../../types/proofread';
import { detectLanguageFromFilename } from './languageDetector';

// 支持的字幕格式
const SUBTITLE_EXTENSIONS = ['.srt', '.vtt', '.ass', '.ssa'];

// 支持的视频格式
const VIDEO_EXTENSIONS = [
  '.mp4',
  '.avi',
  '.mov',
  '.mkv',
  '.flv',
  '.wmv',
  '.webm',
  '.3gp',
  '.ts',
  '.m4v',
];

// 常见的翻译字幕关键词
const TRANSLATED_KEYWORDS = ['translated', '翻译', 'target', 'trans'];

// 常见的原始字幕关键词
const SOURCE_KEYWORDS = ['source', '原文', 'original', 'orig'];

/**
 * 判断文件是否为视频文件
 */
export function isVideoExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return VIDEO_EXTENSIONS.includes(ext);
}

/**
 * 判断文件是否为字幕文件
 */
export function isSubtitleExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SUBTITLE_EXTENSIONS.includes(ext);
}

/**
 * 检测视频文件对应的字幕
 */
export async function detectSubtitlesForVideo(
  videoPath: string,
  sourceLanguage: string,
  targetLanguage: string,
): Promise<SubtitleDetectionResult> {
  const directory = path.dirname(videoPath);
  const videoName = path.basename(videoPath, path.extname(videoPath));

  // 获取目录下所有字幕文件
  let files: string[] = [];
  try {
    const allFiles = await fs.readdir(directory);
    files = allFiles.filter((f) => isSubtitleExtension(f));
  } catch (error) {
    console.error('Error reading directory:', error);
    return { videoFile: videoPath, detectedSubtitles: [] };
  }

  const detectedSubtitles: DetectedSubtitle[] = [];

  for (const file of files) {
    const filePath = path.join(directory, file);
    const detection = analyzeSubtitleFile(
      filePath,
      videoName,
      sourceLanguage,
      targetLanguage,
    );
    if (detection) {
      detectedSubtitles.push(detection);
    }
  }

  // 按置信度排序
  detectedSubtitles.sort((a, b) => b.confidence - a.confidence);

  return {
    videoFile: videoPath,
    detectedSubtitles,
  };
}

/**
 * 分析单个字幕文件，判断其类型和匹配度
 * 不再依赖预设语言，改为自动从文件名检测
 */
function analyzeSubtitleFile(
  filePath: string,
  videoName: string,
  sourceLanguage: string,
  targetLanguage: string,
): DetectedSubtitle | null {
  const fileName = path.basename(filePath, path.extname(filePath));
  const fileNameLower = fileName.toLowerCase();
  const videoNameLower = videoName.toLowerCase();

  // 尝试从文件名检测语言
  const langDetection = detectLanguageFromFilename(filePath);
  const detectedLangCode = langDetection?.code;

  // 规则1: 与视频完全同名（最高置信度，这是最常见的命名方式）
  if (fileNameLower === videoNameLower) {
    return {
      type: 'source',
      filePath,
      language: detectedLangCode, // 可能有也可能没有
      confidence: 95,
    };
  }

  // 规则2: 检测到语言代码且文件名与视频名匹配（如 test.en.srt）
  if (detectedLangCode) {
    // 去除语言后缀后检查是否与视频名匹配
    const baseName = fileNameLower.replace(/\.[a-z]{2}(?:-[a-z]{2,4})?$/i, '');

    if (baseName === videoNameLower || fileNameLower.includes(videoNameLower)) {
      // 根据检测到的语言判断类型
      // 英语通常作为源语言，其他语言作为翻译
      const type = detectedLangCode === 'en' ? 'source' : 'translated';
      return {
        type,
        filePath,
        language: detectedLangCode,
        confidence: 90,
      };
    }
  }

  // 规则3: 包含翻译关键词且包含视频名
  if (
    TRANSLATED_KEYWORDS.some((kw) => fileNameLower.includes(kw)) &&
    fileNameLower.includes(videoNameLower)
  ) {
    return { type: 'translated', filePath, confidence: 75 };
  }

  // 规则4: 包含原文关键词且包含视频名
  if (
    SOURCE_KEYWORDS.some((kw) => fileNameLower.includes(kw)) &&
    fileNameLower.includes(videoNameLower)
  ) {
    return { type: 'source', filePath, confidence: 75 };
  }

  // 规则5: 文件名包含视频名（低置信度）
  if (
    fileNameLower.includes(videoNameLower) ||
    videoNameLower.includes(fileNameLower)
  ) {
    // 如果检测到了语言，也带上
    return {
      type: 'unknown',
      filePath,
      language: detectedLangCode,
      confidence: 50,
    };
  }

  // 规则6: 同目录的其他字幕（最低置信度）
  return {
    type: 'unknown',
    filePath,
    language: detectedLangCode,
    confidence: 30,
  };
}

/**
 * 从文件名中提取基础名称（去除语言后缀）
 */
function extractBaseName(fileName: string): string {
  const name = path.basename(fileName, path.extname(fileName));

  // 通用语言代码模式（移除常见的语言后缀）
  const langPatterns = [
    /\.[a-z]{2}(?:-[A-Za-z]{2,4})?$/i, // .en, .zh-CN 等
    /_(en|zh|ja|ko|fr|de|es|ru|pt|it)$/i, // _en, _zh 等
    /\.(chinese|english|japanese|korean)$/i, // .chinese, .english 等
  ];

  for (const pattern of langPatterns) {
    if (pattern.test(name)) {
      return name.replace(pattern, '');
    }
  }

  return name;
}

/**
 * 根据文件名自动匹配字幕文件对
 * 不再需要预设语言，改为从文件名自动检测
 */
export async function matchSubtitlesByRules(
  files: string[],
  _sourceLanguage?: string,
  _targetLanguage?: string,
): Promise<SubtitleMatchResult[]> {
  // 按目录和基础文件名分组
  const fileGroups = new Map<string, string[]>();

  for (const file of files) {
    if (!isSubtitleExtension(file)) continue;

    const dir = path.dirname(file);
    const baseName = extractBaseName(file);
    const key = `${dir}/${baseName}`;

    if (!fileGroups.has(key)) {
      fileGroups.set(key, []);
    }
    fileGroups.get(key)!.push(file);
  }

  const results: SubtitleMatchResult[] = [];

  // 对每组文件进行匹配
  for (const [key, groupFiles] of Array.from(fileGroups.entries())) {
    const match: SubtitleMatchResult = {
      baseName: path.basename(key),
    };

    // 检测每个文件的语言
    const filesWithLang: Array<{
      file: string;
      lang: string | undefined;
      isEnglish: boolean;
    }> = groupFiles.map((file) => {
      const detection = detectLanguageFromFilename(file);
      return {
        file,
        lang: detection?.code,
        isEnglish: detection?.code === 'en',
      };
    });

    // 查找英语字幕作为源语言（通常是原文）
    const englishFile = filesWithLang.find((f) => f.isEnglish);
    // 查找非英语字幕作为翻译
    const translatedFile = filesWithLang.find((f) => f.lang && !f.isEnglish);

    if (englishFile) {
      match.source = englishFile.file;
      match.sourceLanguage = 'en';
    }
    if (translatedFile) {
      match.target = translatedFile.file;
      match.targetLanguage = translatedFile.lang;
    }

    // 如果没有检测到语言，按关键词匹配
    if (!match.source && !match.target) {
      for (const file of groupFiles) {
        const fileName = path.basename(file, path.extname(file)).toLowerCase();

        if (SOURCE_KEYWORDS.some((kw) => fileName.includes(kw))) {
          match.source = file;
        } else if (TRANSLATED_KEYWORDS.some((kw) => fileName.includes(kw))) {
          match.target = file;
        } else if (!match.source) {
          // 默认第一个作为源
          match.source = file;
        } else if (!match.target) {
          match.target = file;
        }
      }
    }

    // 如果只检测到一种，另一个用默认逻辑填充
    if (match.source && !match.target && groupFiles.length > 1) {
      const other = groupFiles.find((f) => f !== match.source);
      if (other) {
        match.target = other;
        const detection = detectLanguageFromFilename(other);
        match.targetLanguage = detection?.code;
      }
    }
    if (!match.source && match.target && groupFiles.length > 1) {
      const other = groupFiles.find((f) => f !== match.target);
      if (other) {
        match.source = other;
        const detection = detectLanguageFromFilename(other);
        match.sourceLanguage = detection?.code;
      }
    }

    // 只有至少有一个文件的组才加入结果
    if (match.source || match.target) {
      results.push(match);
    }
  }

  return results;
}

/**
 * 扫描目录获取所有字幕文件
 */
export async function scanDirectoryForSubtitles(
  directoryPath: string,
): Promise<string[]> {
  const subtitleFiles: string[] = [];

  try {
    const files = await fs.readdir(directoryPath);

    for (const file of files) {
      const filePath = path.join(directoryPath, file);
      const stat = await fs.stat(filePath);

      if (stat.isFile() && isSubtitleExtension(file)) {
        subtitleFiles.push(filePath);
      }
    }
  } catch (error) {
    console.error('Error scanning directory:', error);
  }

  return subtitleFiles;
}

/**
 * 智能扫描目录 - 返回视频和字幕文件
 */
export async function smartScanDirectory(
  directoryPath: string,
): Promise<{ videos: string[]; subtitles: string[] }> {
  const videos: string[] = [];
  const subtitles: string[] = [];

  try {
    const files = await fs.readdir(directoryPath);

    for (const file of files) {
      const filePath = path.join(directoryPath, file);
      const stat = await fs.stat(filePath);

      if (stat.isFile()) {
        if (isVideoExtension(file)) {
          videos.push(filePath);
        } else if (isSubtitleExtension(file)) {
          subtitles.push(filePath);
        }
      }
    }
  } catch (error) {
    console.error('Error scanning directory:', error);
  }

  return { videos, subtitles };
}

/**
 * 验证字幕文件是否存在且可读
 */
export async function validateSubtitleFile(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fs.constants.R_OK);
    return isSubtitleExtension(filePath);
  } catch {
    return false;
  }
}
