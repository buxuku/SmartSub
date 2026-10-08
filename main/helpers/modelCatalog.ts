import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { store } from './storeManager';
import { getPath } from './whisper';
import { resolveModelRoot } from './storagePaths';
import {
  cacheDirNameToModelId,
  hfRepoToCacheDirName,
  getCt2HfRepo,
} from './fasterWhisperModelCatalog';
import {
  inspectCt2SnapshotRoot,
  type Ct2SnapshotInspection,
} from './modelImport';

/** ggml 路径：语义不变，复用 getPath('modelsPath') */
export function getGgmlModelsPath(): string {
  return getPath('modelsPath') as string;
}

export function getFasterWhisperModelsPath(): string {
  // 解析链：单独覆盖 > 统一存储目录 > userData 默认（storagePaths.ts）
  const resolved = resolveModelRoot(
    'ct2',
    store.get('settings'),
    app.getPath('userData'),
  ).path;
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

/**
 * HuggingFace Hub 标准缓存子目录：{modelsPath}/hub/models--*。
 *
 * 只返回路径，不创建、不搬移：模型路径可能指向与其他 HuggingFace 软件共享的缓存
 * （models--* 直接位于其下，#519），该函数在刷新模型列表、转写、下载时都会被调用，
 * 在这里动用户目录等于每次刷新都改写一次共享缓存。读取侧同时兼容 {modelsPath}/ 与
 * {modelsPath}/hub/（inspectCt2ModelSnapshot / getFasterWhisperModelsInstalled），
 * 目录在首次下载时由下载器按需创建。
 */
export function getFasterWhisperHubDir(): string {
  return path.join(getFasterWhisperModelsPath(), 'hub');
}

export function toCt2CacheDirName(modelId: string): string {
  return hfRepoToCacheDirName(getCt2HfRepo(modelId));
}

export function getCt2ModelCacheDir(modelId: string): string {
  return path.join(getFasterWhisperHubDir(), toCt2CacheDirName(modelId));
}

/** 检查 UI 模型目录下的 snapshot，并保留残缺模型的诊断信息。 */
export function inspectCt2ModelSnapshot(
  modelId: string,
): Ct2SnapshotInspection {
  const dirName = toCt2CacheDirName(modelId);
  const snapshotRoots = [
    path.join(getFasterWhisperHubDir(), dirName, 'snapshots'),
    path.join(getFasterWhisperModelsPath(), dirName, 'snapshots'),
  ];

  let firstIncomplete: Ct2SnapshotInspection | null = null;
  for (const snapshotRoot of snapshotRoots) {
    const inspection = inspectCt2SnapshotRoot(snapshotRoot);
    if (inspection.snapshotDir) return inspection;
    if (!firstIncomplete && inspection.incompleteSnapshotDir) {
      firstIncomplete = inspection;
    }
  }
  return (
    firstIncomplete || {
      ok: false,
      snapshotDir: null,
      incompleteSnapshotDir: null,
      issues: [],
    }
  );
}

/** 仅返回完整、可加载的 CT2 snapshot 绝对路径。 */
export function resolveCt2ModelSnapshotDir(modelId: string): string | null {
  return inspectCt2ModelSnapshot(modelId).snapshotDir;
}

function snapshotDirHasCompleteModel(snapshotRoot: string): boolean {
  return inspectCt2SnapshotRoot(snapshotRoot).snapshotDir !== null;
}

function collectInstalledFromHubLikeDir(
  hubDir: string,
  found: Set<string>,
): void {
  if (!fs.existsSync(hubDir)) return;
  for (const entry of fs.readdirSync(hubDir)) {
    const mapped = cacheDirNameToModelId(entry);
    if (!mapped) continue;
    const snapshotRoot = path.join(hubDir, entry, 'snapshots');
    if (snapshotDirHasCompleteModel(snapshotRoot)) {
      found.add(mapped);
    }
  }
}

/** 扫描 UI 模型目录，返回逻辑模型 id 列表 */
export function getFasterWhisperModelsInstalled(): string[] {
  const root = getFasterWhisperModelsPath();
  const found = new Set<string>();

  collectInstalledFromHubLikeDir(getFasterWhisperHubDir(), found);
  collectInstalledFromHubLikeDir(root, found);

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
