/**
 * 配音工作台 IPC（dubbing: 命名空间）：invoke 统一返回
 * `{success, data?, error?, cancelled?}`，进度经 `dubbing:progress` 事件推送
 * （形制 ipcSubtitleMergeHandlers）。
 */
import { ipcMain, app, BrowserWindow, dialog } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { logMessage } from './storeManager';
import { TaskCancelledError } from './taskContext';
import {
  acquireTaskPowerSaveBlocker,
  releaseTaskPowerSaveBlocker,
} from './powerSaveManager';
import {
  createDubbingSession,
  restoreDubbingSession,
  disposeDubbingSession,
  deleteDubbingSessionData,
  getDubbingSession,
  runDubbingBatch,
  resynthesizeCue,
  acceptOverlongCue,
  setCueVoiceOverride,
  exportDubbing,
  previewVoice,
  cancelDubbing,
  flushDubbingSession,
  type DubbingSession,
  type SessionCue,
} from './dubbing/dubbingProcessor';
import { setDubbingSessionsRoot } from './dubbing/sessionStore';
import { saveWorkItem, getWorkItemById } from './workItemStore';
import type { WorkItem } from '../../types/workItem';
import type { DubbingConfig, DubbingProgressEvent } from '../../types/dubbing';

interface DubbingResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  cancelled?: boolean;
}

const DUBBING_POWER_SAVE_REASON = 'dubbing';

/** 渲染层可见的行视图（剥离 main 侧内部字段）。 */
function cueView(cue: SessionCue) {
  return {
    index: cue.index,
    startMs: cue.startMs,
    endMs: cue.endMs,
    text: cue.text,
    voiceId: cue.voiceId,
    status: cue.status,
    overlap: cue.overlap,
    synthesizedMs: cue.finalMs,
    appliedSpeed: cue.appliedSpeed,
    requiredFactor: cue.requiredFactor,
    wavPath: cue.wavPath,
    error: cue.error,
  };
}

function sessionView(session: DubbingSession) {
  return {
    sessionId: session.id,
    subtitlePath: session.subtitlePath,
    videoPath: session.videoPath,
    mediaDurationMs: session.mediaDurationMs,
    cues: session.cues.map(cueView),
    // 批量在后台进行中：回开重连时渲染层恢复运行态并续接进度事件
    running: session.running,
  };
}

function fail(error: unknown): DubbingResponse {
  if (error instanceof TaskCancelledError) {
    return { success: true, cancelled: true };
  }
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * 配音 workItem：会话首跑创建，导出后补 artifacts。
 * configSnapshot 恒携带 sessionId：最近任务回开按会话恢复行级状态与产物。
 */
function upsertDubbingWorkItem(
  session: DubbingSession,
  status: WorkItem['status'],
  artifacts?: WorkItem['artifacts'],
): void {
  const existing = session.workItemId
    ? getWorkItemById(session.workItemId)
    : null;
  const now = Date.now();
  const snapshot = {
    subtitlePath: session.subtitlePath,
    videoPath: session.videoPath,
    cueCount: session.cues.length,
    sessionId: session.id,
  };
  const item: WorkItem = existing
    ? {
        ...existing,
        status,
        updatedAt: now,
        configSnapshot: { ...existing.configSnapshot, ...snapshot },
        ...(status === 'done' ? { finishedAt: now } : {}),
        ...(artifacts ? { artifacts } : {}),
      }
    : {
        id: `dubbing-${randomUUID()}`,
        name: path.basename(session.subtitlePath),
        type: 'dubbing',
        status,
        createdAt: now,
        updatedAt: now,
        configSnapshot: snapshot,
        ...(artifacts ? { artifacts } : {}),
      };
  session.workItemId = item.id;
  saveWorkItem(item);
}

export function setupDubbingHandlers(mainWindow: BrowserWindow) {
  // 会话持久化根目录：应用数据目录下（dispose 不删除，重开可恢复）
  setDubbingSessionsRoot(
    path.join(app.getPath('userData'), 'dubbing-sessions'),
  );

  const emitProgress = (e: DubbingProgressEvent, cue?: SessionCue) => {
    if (mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('dubbing:progress', {
      ...e,
      cue: cue ? cueView(cue) : undefined,
    });
  };

  // 选择字幕/视频文件（工作台文件条）。
  ipcMain.handle(
    'dubbing:pickFile',
    async (_event, { kind }: { kind: 'subtitle' | 'video' }) => {
      const filters =
        kind === 'subtitle'
          ? [{ name: 'Subtitle', extensions: ['srt', 'vtt', 'ass', 'lrc'] }]
          : [
              {
                name: 'Video/Audio',
                extensions: [
                  'mp4',
                  'mkv',
                  'avi',
                  'mov',
                  'webm',
                  'flv',
                  'ts',
                  'mp3',
                  'wav',
                  'm4a',
                  'flac',
                  'aac',
                ],
              },
            ];
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters,
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, cancelled: true };
      }
      return { success: true, data: result.filePaths[0] };
    },
  );

  // 加载字幕（+ 可选视频）创建会话；携 sessionId 时优先恢复既有会话。
  ipcMain.handle(
    'dubbing:loadSubtitle',
    async (
      _event,
      {
        subtitlePath,
        videoPath,
        sessionId,
        rebuildSessionId,
        workItemId,
      }: {
        subtitlePath: string;
        videoPath?: string;
        /** 尝试恢复的既有会话（最近任务回开携带） */
        sessionId?: string;
        /** 用户确认重建：删除旧会话数据后新建 */
        rebuildSessionId?: string;
        /** 关联的工作项（恢复/重建时保持同一条最近任务记录） */
        workItemId?: string;
      },
    ): Promise<DubbingResponse> => {
      try {
        // 恢复路径：字幕 hash 一致 → 直接恢复行级状态与产物
        if (sessionId) {
          const restored = restoreDubbingSession(sessionId);
          if (restored.kind === 'ok') {
            if (workItemId) restored.session.workItemId = workItemId;
            return {
              success: true,
              data: {
                ...sessionView(restored.session),
                restored: true,
                configSnapshot: restored.session.lastConfig,
              },
            };
          }
          if (restored.kind === 'stale') {
            // 字幕已变：不静默重建，交由用户确认（保留旧产物直至确认）
            return {
              success: true,
              data: {
                stale: true,
                subtitlePath: restored.subtitlePath,
                videoPath: restored.videoPath,
              },
            };
          }
          // missing：无可恢复数据——纯会话打开（检查员/回开未携字幕路径）
          // 时给出明确指引，否则落回按路径新建
          if (!subtitlePath) {
            return {
              success: false,
              error: '配音会话不存在或已被清理，请回到任务重新发起',
            };
          }
        }

        if (!subtitlePath || !fs.existsSync(subtitlePath)) {
          return { success: false, error: '字幕文件不存在' };
        }
        if (videoPath && !fs.existsSync(videoPath)) {
          return { success: false, error: '视频文件不存在' };
        }
        // 用户确认重建：清掉旧会话目录再新建
        if (rebuildSessionId) {
          deleteDubbingSessionData(rebuildSessionId);
        }
        const session = await createDubbingSession(subtitlePath, videoPath);
        if (workItemId) {
          session.workItemId = workItemId;
          // 重建后立即刷新工作项的会话引用，避免旧 sessionId 悬挂
          upsertDubbingWorkItem(
            session,
            getWorkItemById(workItemId)?.status || 'waiting',
          );
        }
        return { success: true, data: sessionView(session) };
      } catch (error) {
        logMessage(`dubbing load failed: ${error}`, 'error');
        return fail(error);
      }
    },
  );

  // 批量合成（全部待处理行）。
  ipcMain.handle(
    'dubbing:start',
    async (
      _event,
      {
        sessionId,
        config,
        force,
      }: { sessionId: string; config: DubbingConfig; force?: boolean },
    ): Promise<DubbingResponse> => {
      const session = getDubbingSession(sessionId);
      if (!session)
        return { success: false, error: '会话不存在，请重新加载字幕' };
      let powerSaveAcquired = false;
      try {
        acquireTaskPowerSaveBlocker(DUBBING_POWER_SAVE_REASON);
        powerSaveAcquired = true;
        upsertDubbingWorkItem(session, 'running');
        const result = await runDubbingBatch(
          session,
          config,
          (e) => {
            const cue =
              e.cueIndex !== undefined
                ? session.cues.find((c) => c.index === e.cueIndex)
                : undefined;
            emitProgress(e, cue);
          },
          { force },
        );
        upsertDubbingWorkItem(
          session,
          result.cancelled
            ? 'interrupted'
            : result.failedIndexes.length > 0
              ? 'error'
              : 'done',
        );
        return {
          success: true,
          data: { ...result, cues: session.cues.map(cueView) },
          cancelled: result.cancelled,
        };
      } catch (error) {
        upsertDubbingWorkItem(session, 'error');
        logMessage(`dubbing batch failed: ${error}`, 'error');
        return fail(error);
      } finally {
        if (powerSaveAcquired) {
          releaseTaskPowerSaveBlocker(DUBBING_POWER_SAVE_REASON);
        }
        // 批量终态事件：页面离开后重连的渲染层靠它退出运行态
        // （发起批量的 invoke promise 随页面卸载丢失，事件是唯一通知通道）
        emitProgress({
          taskId: session.id,
          stage: 'done',
          percent: 100,
        });
      }
    },
  );

  // 单行重生成（可携新文本 / 新 voice）。
  ipcMain.handle(
    'dubbing:resynthesizeCue',
    async (
      _event,
      {
        sessionId,
        index,
        text,
        voiceId,
        config,
      }: {
        sessionId: string;
        index: number;
        text?: string;
        voiceId?: string;
        config: DubbingConfig;
      },
    ): Promise<DubbingResponse> => {
      const session = getDubbingSession(sessionId);
      if (!session)
        return { success: false, error: '会话不存在，请重新加载字幕' };
      try {
        const cue = await resynthesizeCue(
          session,
          index,
          { text, voiceId },
          config,
        );
        return { success: true, data: cueView(cue) };
      } catch (error) {
        return fail(error);
      }
    },
  );

  // 行级 voice 覆盖仅记录（pending 行,批量时生效）。
  ipcMain.handle(
    'dubbing:setCueVoice',
    async (
      _event,
      {
        sessionId,
        index,
        voiceId,
      }: { sessionId: string; index: number; voiceId: string },
    ): Promise<DubbingResponse> => {
      const session = getDubbingSession(sessionId);
      if (!session)
        return { success: false, error: '会话不存在，请重新加载字幕' };
      try {
        const cue = setCueVoiceOverride(session, index, voiceId);
        return { success: true, data: cueView(cue) };
      } catch (error) {
        return fail(error);
      }
    },
  );

  // 过长行「接受变速」。
  ipcMain.handle(
    'dubbing:acceptOverlong',
    async (
      _event,
      { sessionId, index }: { sessionId: string; index: number },
    ): Promise<DubbingResponse> => {
      const session = getDubbingSession(sessionId);
      if (!session)
        return { success: false, error: '会话不存在，请重新加载字幕' };
      try {
        const cue = await acceptOverlongCue(session, index);
        return { success: true, data: cueView(cue) };
      } catch (error) {
        return fail(error);
      }
    },
  );

  // 行级回放：返回该行合成 wav 路径（media:// 播放）。
  ipcMain.handle(
    'dubbing:cueAudio',
    async (
      _event,
      { sessionId, index }: { sessionId: string; index: number },
    ): Promise<DubbingResponse> => {
      const session = getDubbingSession(sessionId);
      const cue = session?.cues.find((c) => c.index === index);
      if (!cue?.wavPath || !fs.existsSync(cue.wavPath)) {
        return { success: false, error: '该行还没有合成结果' };
      }
      return { success: true, data: cue.wavPath };
    },
  );

  // 试听（合成前预听 voice 效果；克隆引擎随工作台质量档）。
  ipcMain.handle(
    'dubbing:previewVoice',
    async (
      _event,
      {
        engine,
        voiceId,
        text,
        cloneQuality,
      }: {
        engine: DubbingConfig['engine'];
        voiceId: string;
        text?: string;
        cloneQuality?: DubbingConfig['cloneQuality'];
      },
    ): Promise<DubbingResponse> => {
      try {
        const r = await previewVoice(engine, voiceId, text, { cloneQuality });
        return { success: true, data: r.wavPath };
      } catch (error) {
        return fail(error);
      }
    },
  );

  // 导出（拼接 → 背景音/输出形态 → 可选顺延字幕）。
  ipcMain.handle(
    'dubbing:export',
    async (
      _event,
      { sessionId, config }: { sessionId: string; config: DubbingConfig },
    ): Promise<DubbingResponse> => {
      const session = getDubbingSession(sessionId);
      if (!session)
        return { success: false, error: '会话不存在，请重新加载字幕' };
      let powerSaveAcquired = false;
      try {
        acquireTaskPowerSaveBlocker(DUBBING_POWER_SAVE_REASON);
        powerSaveAcquired = true;
        const result = await exportDubbing(session, config, (e) =>
          emitProgress(e),
        );
        const artifacts: WorkItem['artifacts'] = [
          {
            kind: config.output === 'audioOnly' ? 'audio' : 'video',
            path: result.outputPath,
          },
          ...(result.shiftedSubtitlePath
            ? [{ kind: 'subtitle', path: result.shiftedSubtitlePath }]
            : []),
        ];
        upsertDubbingWorkItem(session, 'done', artifacts);
        return {
          success: true,
          data: {
            outputPath: result.outputPath,
            shiftedSubtitlePath: result.shiftedSubtitlePath,
            skippedIndexes: result.skippedIndexes,
          },
        };
      } catch (error) {
        logMessage(`dubbing export failed: ${error}`, 'error');
        return fail(error);
      } finally {
        if (powerSaveAcquired) {
          releaseTaskPowerSaveBlocker(DUBBING_POWER_SAVE_REASON);
        }
      }
    },
  );

  // 取消当前批量/导出。
  ipcMain.handle(
    'dubbing:cancel',
    async (_event, { sessionId }: { sessionId: string }) => {
      const session = getDubbingSession(sessionId);
      if (!session) return { success: true, data: false };
      return { success: true, data: cancelDubbing(session) };
    },
  );

  // 释放会话（关闭页面/换文件）。keepRunning=true 时批量在后台继续。
  ipcMain.handle(
    'dubbing:disposeSession',
    async (
      _event,
      { sessionId, keepRunning }: { sessionId: string; keepRunning?: boolean },
    ) => {
      disposeDubbingSession(sessionId, { keepRunning });
      return { success: true, data: true };
    },
  );

  logMessage('配音 IPC 处理函数已注册', 'info');
}
