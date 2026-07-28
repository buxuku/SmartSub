/**
 * 词级时间轴 sidecar 读写（openspec: add-ai-subtitle-refine D6）。
 *
 * 落盘位置：`<tempAudioFile>.words.json`——与抽取音频同目录（统一临时目录），
 * 随既有临时文件清理机制回收，不污染用户输出目录；文件名经 md5 与媒体绑定，
 * 任务重试续跑时可直接复用（sidecar 在即不重转写也能重跑精修）。
 *
 * 读写均非致命：失败只记日志，精修阶段对缺失/损坏的 sidecar 自动走近似模式。
 */

import fs from 'fs';
import { logMessage } from './storeManager';
import type { RefineWord, WordTimelineSidecar } from './subtitleRefine/types';

export function wordTimelineSidecarPath(tempAudioFile: string): string {
  return `${tempAudioFile}.words.json`;
}

/** 写入 sidecar；成功返回路径，失败/无内容返回 undefined（调用方据此置 file 字段）。 */
export function writeWordTimelineSidecar(
  tempAudioFile: string | undefined,
  engine: string,
  words: RefineWord[],
): string | undefined {
  if (!tempAudioFile || !Array.isArray(words) || words.length === 0) {
    return undefined;
  }
  const sidecarPath = wordTimelineSidecarPath(tempAudioFile);
  try {
    const payload: WordTimelineSidecar = { version: 1, engine, words };
    fs.writeFileSync(sidecarPath, JSON.stringify(payload));
    return sidecarPath;
  } catch (error) {
    logMessage(
      `word timeline sidecar write failed (non-fatal): ${
        error instanceof Error ? error.message : String(error)
      }`,
      'warning',
    );
    return undefined;
  }
}

/** 读取并校验 sidecar；缺失/损坏/版本不符返回 null（调用方降级近似模式）。 */
export function readWordTimelineSidecar(
  sidecarPath: string | undefined,
): WordTimelineSidecar | null {
  if (!sidecarPath) return null;
  try {
    if (!fs.existsSync(sidecarPath)) return null;
    const parsed = JSON.parse(
      fs.readFileSync(sidecarPath, 'utf8'),
    ) as Partial<WordTimelineSidecar> | null;
    if (
      !parsed ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.words) ||
      parsed.words.length === 0
    ) {
      return null;
    }
    return parsed as WordTimelineSidecar;
  } catch (error) {
    logMessage(
      `word timeline sidecar read failed (non-fatal): ${
        error instanceof Error ? error.message : String(error)
      }`,
      'warning',
    );
    return null;
  }
}
