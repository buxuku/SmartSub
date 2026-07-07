/**
 * 配音工作台 IPC（dubbing: 命名空间）：invoke 统一返回
 * `{success, data?, error?, cancelled?}`，进度经 `dubbing:progress` 事件推送
 * （形制 ipcSubtitleMergeHandlers）。
 */
import { ipcMain, BrowserWindow, dialog } from 'electron';
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
  disposeDubbingSession,
  getDubbingSession,
  runDubbingBatch,
  resynthesizeCue,
  acceptOverlongCue,
  setCueVoiceOverride,
  exportDubbing,
  previewVoice,
  cancelDubbing,
  type DubbingSession,
  type SessionCue,
} from './dubbing/dubbingProcessor';
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

/** 配音 workItem：会话首跑创建，导出后补 artifacts。 */
function upsertDubbingWorkItem(
  session: DubbingSession,
  status: WorkItem['status'],
  artifacts?: WorkItem['artifacts'],
): void {
  const existing = session.workItemId
    ? getWorkItemById(session.workItemId)
    : null;
  const now = Date.now();
  const item: WorkItem = existing
    ? {
        ...existing,
        status,
        updatedAt: now,
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
        configSnapshot: {
          subtitlePath: session.subtitlePath,
          videoPath: session.videoPath,
          cueCount: session.cues.length,
        },
        ...(artifacts ? { artifacts } : {}),
      };
  session.workItemId = item.id;
  saveWorkItem(item);
}

export function setupDubbingHandlers(mainWindow: BrowserWindow) {
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

  // 加载字幕（+ 可选视频）创建会话。
  ipcMain.handle(
    'dubbing:loadSubtitle',
    async (
      _event,
      { subtitlePath, videoPath }: { subtitlePath: string; videoPath?: string },
    ): Promise<DubbingResponse> => {
      try {
        if (!subtitlePath || !fs.existsSync(subtitlePath)) {
          return { success: false, error: '字幕文件不存在' };
        }
        if (videoPath && !fs.existsSync(videoPath)) {
          return { success: false, error: '视频文件不存在' };
        }
        const session = await createDubbingSession(subtitlePath, videoPath);
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

  // 试听（合成前预听 voice 效果）。
  ipcMain.handle(
    'dubbing:previewVoice',
    async (
      _event,
      {
        engine,
        voiceId,
        text,
      }: {
        engine: DubbingConfig['engine'];
        voiceId: string;
        text?: string;
      },
    ): Promise<DubbingResponse> => {
      try {
        const r = await previewVoice(engine, voiceId, text);
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

  // 释放会话（关闭页面/换文件）。
  ipcMain.handle(
    'dubbing:disposeSession',
    async (_event, { sessionId }: { sessionId: string }) => {
      disposeDubbingSession(sessionId);
      return { success: true, data: true };
    },
  );

  logMessage('配音 IPC 处理函数已注册', 'info');
}
