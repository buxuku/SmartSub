import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import { store } from '../store';
import type { ClonedVoice } from '../../../types/voiceClone';

/**
 * 克隆音色（我的音色）读写管理（形制 ttsProviderManager）+ 每音色文件目录：
 * `userData/voiceClones/<id>/`（ref.wav 参考音频 / sample.wav 试听样本）。
 * 删除音色同步清理目录——参考音频是音色的构成部分而非缓存。
 */

export function getVoiceClonesRoot(): string {
  const root = path.join(app.getPath('userData'), 'voiceClones');
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

export function getClonedVoiceDir(id: string): string {
  const dir = path.join(getVoiceClonesRoot(), id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function newClonedVoiceId(): string {
  return `cv_${randomUUID()}`;
}

export function getClonedVoices(): ClonedVoice[] {
  return store.get('clonedVoices') || [];
}

export function getClonedVoiceById(
  id: string | undefined,
): ClonedVoice | undefined {
  if (!id) return undefined;
  return getClonedVoices().find((v) => v.id === id);
}

export function saveClonedVoice(voice: ClonedVoice): void {
  const list = getClonedVoices();
  const i = list.findIndex((v) => v.id === voice.id);
  if (i >= 0) list[i] = voice;
  else list.push(voice);
  store.set('clonedVoices', list);
}

export function renameClonedVoice(id: string, name: string): ClonedVoice {
  const voice = getClonedVoiceById(id);
  if (!voice) throw new Error(`克隆音色不存在：${id}`);
  const next = { ...voice, name: name.trim() || voice.name };
  saveClonedVoice(next);
  return next;
}

export function removeClonedVoice(id: string): void {
  store.set(
    'clonedVoices',
    getClonedVoices().filter((v) => v.id !== id),
  );
  const dir = path.join(getVoiceClonesRoot(), id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/** 默认命名：「我的音色 N」（N = 现有数量 + 1，重名不校验——id 才是标识）。 */
export function nextClonedVoiceName(prefix: string): string {
  return `${prefix} ${getClonedVoices().length + 1}`;
}
