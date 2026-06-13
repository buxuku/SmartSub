import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { store } from './storeManager';
import { getPath } from './whisper';

/** ggml 路径：语义不变，复用 getPath('modelsPath') */
export function getGgmlModelsPath(): string {
  return getPath('modelsPath') as string;
}

export function getFasterWhisperModelsPath(): string {
  const settings = store.get('settings');
  const userData = app.getPath('userData');
  const resolved =
    settings?.fasterWhisperModelsPath ||
    path.join(userData, 'faster-whisper-models');
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

/** 扫描 HF 缓存目录，返回逻辑模型 id 列表 */
export function getFasterWhisperModelsInstalled(): string[] {
  const root = getFasterWhisperModelsPath();
  const cache = path.join(app.getPath('userData'), 'py-engine-cache');
  const dirs = [root, cache];
  const found = new Set<string>();
  const prefix = 'models--Systran--faster-whisper-';

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(prefix)) {
        found.add(entry.slice(prefix.length).replace(/-/g, '.'));
      }
      // 也支持直接以模型 id 命名的子目录（手动导入）
      if (fs.existsSync(path.join(dir, entry, 'model.bin'))) {
        found.add(entry);
      }
    }
  }
  return Array.from(found).sort();
}

/** ggml 模型名 → faster-whisper id */
export function toFasterWhisperModelId(ggmlName: string): string {
  const base = ggmlName
    .toLowerCase()
    .replace(/-q\d+_\d+$/, '')
    .replace(/\.en$/, '.en');
  const map: Record<string, string> = {
    'large-v3-turbo': 'large-v3-turbo',
    'large-v3': 'large-v3',
    'large-v2': 'large-v2',
    'large-v1': 'large-v1',
  };
  return map[base] || base;
}
