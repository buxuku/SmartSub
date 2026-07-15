/**
 * 配音阶段文本源解析：纯译文优先，绝不把双语字幕喂给 TTS。
 *
 * 优先级：
 *  1. 纯译文中间产物（tempTranslatedSrtFile，翻译期恒生成的临时纯译文 srt）
 *  2. 校对 sidecar 译文列重建（tempTranslatedSrtFile 被临时目录清理时的兜底；
 *     校对保存后 sidecar 即最新译文，天然吸收人工修改）
 *  3. 纯译文交付物（translateContent==='onlyTranslate' 且非 txt）
 *  4. 无翻译任务：源字幕（srtFile；字幕输入任务即原文件）
 *
 * 判定逻辑为纯函数（fs 注入），供单测覆盖。
 */

import type { IFiles, IFormData } from '../../../types';

/** 校对 sidecar 的 cue 形状（与 proofreadData.ProofreadDataCue 结构兼容；
 * 此处本地声明以保持本模块零主进程依赖、可在纯 node 下单测） */
export interface SidecarCue {
  id: string;
  startMs: number;
  endMs: number;
  source: string;
  target: string;
}

/** 字幕 cue 形状（与 subtitleFormats.SubtitleCue 结构兼容） */
export interface DubSubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
}

export type DubTextSource =
  | { type: 'ready'; path: string }
  | { type: 'sidecar'; sidecarPath: string }
  | { type: 'error'; reason: 'missing-subtitle' | 'bilingual-unresolvable' };

function isPlainText(p?: string): boolean {
  return /\.txt$/i.test(p || '');
}

/** 任务是否带翻译段（与 fileProcessor 的 shouldTranslateSubtitle 同判定） */
export function taskHasTranslation(formData: {
  taskType?: string;
  translateProvider?: string;
}): boolean {
  const shouldTranslate =
    formData?.taskType === 'generateAndTranslate' ||
    formData?.taskType === 'translateOnly';
  return shouldTranslate && formData?.translateProvider !== '-1';
}

/** 选取配音文本源（纯函数，exists 注入） */
export function pickDubTextSource(
  file: Pick<
    IFiles,
    | 'srtFile'
    | 'tempSrtFile'
    | 'tempTranslatedSrtFile'
    | 'translatedSrtFile'
    | 'proofreadDataFile'
    | 'filePath'
  >,
  formData: Pick<
    IFormData,
    'taskType' | 'translateContent' | 'subtitleOutputFormat'
  > & { translateProvider?: string },
  exists: (p: string) => boolean,
): DubTextSource {
  if (taskHasTranslation(formData)) {
    if (file.tempTranslatedSrtFile && exists(file.tempTranslatedSrtFile)) {
      return { type: 'ready', path: file.tempTranslatedSrtFile };
    }
    if (file.proofreadDataFile && exists(file.proofreadDataFile)) {
      return { type: 'sidecar', sidecarPath: file.proofreadDataFile };
    }
    if (
      formData.translateContent === 'onlyTranslate' &&
      file.translatedSrtFile &&
      !isPlainText(file.translatedSrtFile) &&
      exists(file.translatedSrtFile)
    ) {
      // 纯译文交付物（非双语模板）：可直接使用
      return { type: 'ready', path: file.translatedSrtFile };
    }
    // 仅剩双语交付物且无 sidecar：无法安全重建纯译文
    return { type: 'error', reason: 'bilingual-unresolvable' };
  }

  // 无翻译：源字幕（ASR 产物 / 用户导入的字幕文件 / noSave 时的临时缓存）
  const candidates = [file.srtFile, file.tempSrtFile, file.filePath];
  for (const candidate of candidates) {
    if (candidate && !isPlainText(candidate) && exists(candidate)) {
      return { type: 'ready', path: candidate };
    }
  }
  return { type: 'error', reason: 'missing-subtitle' };
}

/** sidecar 译文列 → 字幕 cues（纯函数；空译文行保留时间轴占位为空文本） */
export function cuesFromSidecarTargets(cues: SidecarCue[]): DubSubtitleCue[] {
  return cues.map((cue) => ({
    startMs: cue.startMs,
    endMs: cue.endMs,
    text: (cue.target || '').trim(),
  }));
}
