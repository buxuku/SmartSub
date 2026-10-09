/**
 * 校对 sidecar 的托管存储位置与生命周期。
 *
 * 新生成的 sidecar 写入宿主注入的托管目录（应用侧 = userData/proofread-data），
 * 不再散落在用户视频旁的 .smartsub-proofread/。宿主未注入时回落旧的邻居目录，
 * 脚本与单测无需改动；存量 sidecar 继续按各自记录的绝对路径读写，不做迁移。
 *
 * 删除工作项时，只回收托管目录里不再被任何工作项引用的 sidecar；旧邻居目录里
 * 的文件、托管目录之外的路径一律不碰。
 *
 * 零 electron 依赖：被纯 node 编译运行的配音脚本（speakerMetadata）与单测共用。
 */

import fs from 'fs';
import path from 'path';
import type { WorkItem } from '../../types/workItem';

/** 旧版把 sidecar 放在视频目录旁的这个文件夹里；存量文件仍在其中，不会被自动清理。 */
export const LEGACY_PROOFREAD_DIR = '.smartsub-proofread';

/** 路径判定用到的 path 子集；传 path.win32 / path.posix 可按另一个平台的规则校验。 */
export type PathApi = Pick<
  typeof path,
  'resolve' | 'relative' | 'isAbsolute' | 'extname' | 'sep'
>;

let managedRoot: string | undefined;

/**
 * 宿主注入托管目录（应用启动时以 userData/proofread-data 调用）。
 * 传 undefined 复位为未注入状态，供单测隔离使用。
 */
export function setProofreadDataRoot(dir: string | undefined): void {
  managedRoot = dir ? path.resolve(dir) : undefined;
}

/** 当前托管目录；宿主未注入时为 undefined，此时 sidecar 回落到视频旁的旧目录 */
export function getProofreadDataRoot(): string | undefined {
  return managedRoot;
}

/**
 * 校验一个待删除的 sidecar 路径，通过则返回规范化后的绝对路径，否则 null。
 *
 * 只认直接放在托管目录下的 .json 文件：根目录本身、子目录里的文件、含 `..`
 * 越界的路径、其他盘符、相对路径一律拒绝。不接受子目录，是为了不经由目录符号
 * 链接逃出托管目录。比较走 pathApi.relative，Windows 上由 Node 保证不分大小写。
 */
function resolveManagedPath(
  filePath: unknown,
  root: string | undefined,
  pathApi: PathApi,
): string | null {
  if (!root || typeof filePath !== 'string' || !filePath) return null;
  if (!pathApi.isAbsolute(filePath)) return null;
  if (pathApi.extname(filePath).toLowerCase() !== '.json') return null;
  const resolved = pathApi.resolve(filePath);
  const relative = pathApi.relative(pathApi.resolve(root), resolved);
  if (
    !relative ||
    relative === '..' ||
    relative.includes(pathApi.sep) ||
    pathApi.isAbsolute(relative)
  ) {
    return null;
  }
  return resolved;
}

/**
 * 路径是否位于托管目录内、可被回收。root 不传时用宿主注入的托管目录。
 */
export function isManagedProofreadPath(
  filePath: string,
  root: string | undefined = getProofreadDataRoot(),
  pathApi: PathApi = path,
): boolean {
  return resolveManagedPath(filePath, root, pathApi) !== null;
}

function sidecarPathsOf(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  return files.flatMap((file) => {
    const value = (file as { proofreadDataFile?: unknown } | null)
      ?.proofreadDataFile;
    return typeof value === 'string' && value ? [value] : [];
  });
}

/**
 * 工作项仍指向的全部 sidecar 路径：任务文件、校对批次条目、任务草稿稿件，
 * 以及配音工作项快照里记录的那份。字段缺失或形状损坏时按没有处理，不抛错。
 */
export function collectProofreadDataFiles(item: WorkItem): string[] {
  const snapshot = item?.configSnapshot?.proofreadDataFile;
  return [
    ...sidecarPathsOf(item?.pipelineFiles),
    ...sidecarPathsOf(item?.proofreadEntries),
    ...sidecarPathsOf(item?.taskDraft?.manuscripts),
    ...(typeof snapshot === 'string' && snapshot ? [snapshot] : []),
  ];
}

/** 判断"是不是同一个文件"用的键；大小写不敏感，宁可多保留也不误删。 */
function sameFileKey(filePath: string, pathApi: PathApi): string {
  try {
    return pathApi.resolve(filePath).toLowerCase();
  } catch {
    return filePath.toLowerCase();
  }
}

export interface ProofreadDataPathOptions {
  /** 托管目录；不传则用宿主注入的 */
  root?: string;
  pathApi?: PathApi;
}

/**
 * 删除 `deleting` 之后哪些托管 sidecar 可以一并回收：
 * 被它们引用、位于托管目录内、且不再被任何 `remaining` 工作项引用。
 */
export function planManagedDeletion(
  deleting: readonly WorkItem[],
  remaining: readonly WorkItem[],
  options: ProofreadDataPathOptions = {},
): string[] {
  const root = options.root ?? getProofreadDataRoot();
  const pathApi = options.pathApi ?? path;
  if (!root) return [];
  const stillUsed = new Set(
    remaining
      .flatMap(collectProofreadDataFiles)
      .map((file) => sameFileKey(file, pathApi)),
  );
  const planned = new Map<string, string>();
  for (const item of deleting) {
    for (const file of collectProofreadDataFiles(item)) {
      const target = resolveManagedPath(file, root, pathApi);
      if (!target) continue;
      const key = sameFileKey(target, pathApi);
      if (!stillUsed.has(key)) planned.set(key, target);
    }
  }
  return [...planned.values()];
}

export interface RemoveProofreadDataOptions extends ProofreadDataPathOptions {
  /** 删除失败时的回调（只报告，不抛错）；本模块不依赖日志实现 */
  onError?: (message: string) => void;
}

/**
 * 删除 sidecar，返回实际删掉的路径。每个路径再校验一遍：必须在托管目录内，
 * 且 lstat 为普通文件（符号链接、目录一律不动）。已不存在的文件静默跳过，
 * 其他失败只通过 onError 报告，不影响其余文件，更不会抛错。
 */
export function removeManagedProofreadData(
  files: readonly string[],
  options: RemoveProofreadDataOptions = {},
): string[] {
  const root = options.root ?? getProofreadDataRoot();
  const pathApi = options.pathApi ?? path;
  const removed: string[] = [];
  for (const file of files) {
    const target = resolveManagedPath(file, root, pathApi);
    if (!target) continue;
    try {
      if (!fs.lstatSync(target).isFile()) continue;
      fs.unlinkSync(target);
      removed.push(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      options.onError?.(
        `proofread data: could not remove ${target}: ${String(error)}`,
      );
    }
  }
  return removed;
}
