/**
 * 配音会话持久化（session.json + 行级 wav 常驻会话目录）。
 *
 * 会话目录 <sessionsRoot>/<sessionId>/ 内含逐行合成 wav 与 session.json 元数据；
 * dispose（换文件/关页面）不再删除目录，重开可恢复行级状态与产物。
 * 元数据写盘节流 800ms（与 workItemStore 同模式），关键节点可 flush。
 *
 * 零 electron 依赖：sessionsRoot 由宿主注入（应用侧 = userData/dubbing-sessions；
 * 单测/脚本回落系统临时目录），本模块可在纯 node 下运行。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import type {
  DubbingSessionMeta,
  PersistedDubbingCue,
} from '../../../types/dubbing';
import { DUBBING_SESSION_META_VERSION } from '../../../types/dubbing';

const META_FILE = 'session.json';
const WRITE_DEBOUNCE_MS = 800;

let sessionsRoot: string | null = null;
const writeTimers = new Map<string, NodeJS.Timeout>();
const pendingMeta = new Map<string, DubbingSessionMeta>();
const unresolvedDeletions = new Set<string>();
let deletionRecoveryUnavailable = false;

export function assertSessionAvailable(sessionId: string): void {
  if (deletionRecoveryUnavailable || unresolvedDeletions.has(sessionId))
    throw new Error(
      'Dubbing deletion recovery is incomplete; check disk permissions and restart before opening this project',
    );
}

/** 宿主注入会话根目录（应用启动时以 userData 调用；不调用则回落临时目录） */
export function setDubbingSessionsRoot(dir: string): void {
  sessionsRoot = dir;
}

export function getDubbingSessionsRoot(): string {
  if (!sessionsRoot) {
    sessionsRoot = path.join(
      os.tmpdir(),
      'video-subtitle-master',
      'dubbing-sessions',
    );
  }
  return sessionsRoot;
}

export function getSessionDir(sessionId: string): string {
  if (
    typeof sessionId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(sessionId)
  )
    throw new Error('Invalid dubbing session identifier');
  return path.join(getDubbingSessionsRoot(), sessionId);
}

export function getSessionDraftPath(
  sessionId: string,
  kind: 'config' | 'cue',
): string {
  if (typeof sessionId !== 'string' || !sessionId)
    throw new Error('Invalid dubbing session');
  return path.join(
    getDubbingSessionsRoot(),
    `.${kind}-drafts`,
    createHash('sha256').update(sessionId).digest('hex') + '.json',
  );
}

function cancelPendingWrite(sessionId: string): void {
  const timer = writeTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  writeTimers.delete(sessionId);
  pendingMeta.delete(sessionId);
}

function entryExists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Stage on the same filesystem; failed task-store publication restores exact bytes. */
export function stageSessionDeletion(sessionIds: string[]) {
  const ids = [...new Set(sessionIds)];
  ids.forEach(getSessionDir);
  ids.forEach(assertSessionAvailable);
  const directory = path.join(
    getDubbingSessionsRoot(),
    '.deleted',
    randomUUID(),
  );
  if (!ids.length) return { rollback() {}, commit() {} };
  fs.mkdirSync(directory, { recursive: true });
  const manifest = path.join(directory, 'manifest.json');
  try {
    const fd = fs.openSync(manifest, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: 1, ids }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    // No session has moved until the manifest is durable.
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error('Dubbing deletion manifest cleanup deferred', cleanupError);
    }
    throw error;
  }
  const moved: Array<{ source: string; staged: string }> = [];
  const rollback = () => {
    try {
      for (const entry of [...moved].reverse()) {
        if (entryExists(entry.source))
          throw new Error('Deletion rollback conflicts with existing data');
        fs.renameSync(entry.staged, entry.source);
      }
      fs.rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      ids.forEach((id) => unresolvedDeletions.add(id));
      throw error;
    }
  };
  try {
    for (const id of ids) {
      for (const [name, source] of [
        ['session', getSessionDir(id)],
        ['config', getSessionDraftPath(id, 'config')],
        ['cue', getSessionDraftPath(id, 'cue')],
      ]) {
        const staged = path.join(directory, `${id}.${name}`);
        try {
          fs.renameSync(source, staged);
          moved.push({ source, staged });
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
  } catch (error) {
    rollback();
    throw error;
  }
  return {
    rollback,
    commit() {
      ids.forEach(cancelPendingWrite);
      // Retained transaction directories are retried at startup, never reported as a failed deletion.
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        console.error('Dubbing deletion cleanup deferred', error);
      }
    },
  };
}

export function recoverSessionDeletions(referenced: Set<string>): void {
  const root = path.join(getDubbingSessionsRoot(), '.deleted');
  deletionRecoveryUnavailable = false;
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    deletionRecoveryUnavailable = true;
    console.error('Dubbing deletion recovery directory is unavailable', error);
    return;
  }
  for (const name of entries) {
    if (!/^[a-f0-9-]{36}$/.test(name)) continue;
    const directory = path.join(root, name);
    let ids: string[] = [];
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'),
      );
      if (manifest.version !== 1 || !Array.isArray(manifest.ids))
        throw new Error('Invalid dubbing deletion manifest');
      manifest.ids.forEach(getSessionDir);
      ids = manifest.ids;
      for (const id of manifest.ids) {
        if (!referenced.has(id)) continue;
        for (const [kind, destination] of [
          ['session', getSessionDir(id)],
          ['config', getSessionDraftPath(id, 'config')],
          ['cue', getSessionDraftPath(id, 'cue')],
        ]) {
          const staged = path.join(directory, `${id}.${kind}`);
          if (!entryExists(staged)) continue;
          if (entryExists(destination))
            throw new Error(
              'Dubbing deletion recovery conflicts with existing data',
            );
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.renameSync(staged, destination);
        }
      }
      fs.rmSync(directory, { recursive: true, force: true });
      ids.forEach((id) => unresolvedDeletions.delete(id));
    } catch (error) {
      // An unreadable manifest cannot tell us which sessions need protection.
      if (!ids.length) deletionRecoveryUnavailable = true;
      ids.forEach((id) => unresolvedDeletions.add(id));
      console.error('Dubbing deletion recovery requires retry', error);
    }
  }
}

/** 字幕内容 hash（恢复合法性校验依据） */
export function hashSubtitleContent(content: string): string {
  return createHash('sha1').update(content, 'utf-8').digest('hex');
}

function metaPath(sessionId: string): string {
  return path.join(getSessionDir(sessionId), META_FILE);
}

function writeMetaNow(meta: DubbingSessionMeta): void {
  assertSessionAvailable(meta.sessionId);
  const dir = getSessionDir(meta.sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${META_FILE}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(meta), 'utf-8');
  fs.renameSync(tmp, metaPath(meta.sessionId));
}

/** 节流写盘：崩溃最多丢最近一个防抖窗口内的变更 */
export function persistSessionMeta(meta: DubbingSessionMeta): void {
  pendingMeta.set(meta.sessionId, meta);
  if (writeTimers.has(meta.sessionId)) return;
  writeTimers.set(
    meta.sessionId,
    setTimeout(() => {
      writeTimers.delete(meta.sessionId);
      const latest = pendingMeta.get(meta.sessionId);
      pendingMeta.delete(meta.sessionId);
      if (!latest) return;
      try {
        writeMetaNow(latest);
      } catch {
        /* 写盘失败不阻断合成主流程 */
      }
    }, WRITE_DEBOUNCE_MS),
  );
}

/** 立即落盘（批量结束/dispose 等关键节点） */
export function flushSessionMeta(
  meta: DubbingSessionMeta,
  strict = false,
): void {
  // A rejected explicit edit must not discard an earlier queued snapshot.
  if (strict) writeMetaNow(meta);
  const timer = writeTimers.get(meta.sessionId);
  if (timer) {
    clearTimeout(timer);
    writeTimers.delete(meta.sessionId);
  }
  pendingMeta.delete(meta.sessionId);
  try {
    if (!strict) writeMetaNow(meta);
  } catch (error) {
    if (strict) throw error;
  }
}

/** 读取会话元数据（不存在/版本不符/损坏返回 null） */
export function readSessionMeta(sessionId: string): DubbingSessionMeta | null {
  assertSessionAvailable(sessionId);
  try {
    const raw = fs.readFileSync(metaPath(sessionId), 'utf-8');
    const meta = JSON.parse(raw) as DubbingSessionMeta;
    if (meta?.version !== DUBBING_SESSION_META_VERSION) return null;
    if (!Array.isArray(meta.cues)) return null;
    return meta;
  } catch {
    return null;
  }
}

/** 删除会话目录（工作项删除联动/用户确认重建时调用） */
export function deleteSessionData(sessionId: string): void {
  if (!sessionId) return;
  const staged = stageSessionDeletion([sessionId]);
  staged.commit();
}

/** 清空全部会话目录（清空全部工作项联动） */
export function deleteAllSessionData(): void {
  writeTimers.forEach((timer) => clearTimeout(timer));
  writeTimers.clear();
  pendingMeta.clear();
  try {
    fs.rmSync(getDubbingSessionsRoot(), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** 恢复会话时解析行记录：产物文件缺失的行降级回待合成 */
export function resolvePersistedCue(
  sessionId: string,
  cue: PersistedDubbingCue,
): PersistedDubbingCue & { wavPath?: string } {
  if (!cue.wavFile) return { ...cue, wavPath: undefined };
  const wavPath = path.join(getSessionDir(sessionId), cue.wavFile);
  if (fs.existsSync(wavPath)) {
    return { ...cue, wavPath };
  }
  // 产物缺失：仅该行降级（保留文本/时间轴/行级 voice 覆盖）
  return {
    ...cue,
    wavPath: undefined,
    wavFile: undefined,
    status: cue.status === 'failed' ? 'failed' : 'pending',
    finalMs: undefined,
    appliedSpeed: undefined,
    synthesizedVoiceId: undefined,
    synthesizedInputKey: undefined,
    needsUpdate: false,
    action: { type: 'none' },
  };
}
