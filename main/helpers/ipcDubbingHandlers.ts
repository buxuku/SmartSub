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
  forgetDubbingSession,
  getDubbingSession,
  runDubbingBatch,
  resynthesizeCue,
  borrowFollowingSilence,
  setCueVoiceOverride,
  setSpeakerVoiceMapping,
  setSpeakerSettings,
  setDubbingMedia,
  saveDubbingConfig,
  saveDubbingCueTexts,
  exportDubbing,
  previewVoice,
  cancelDubbing,
  type DubbingSession,
  type SessionCue,
} from './dubbing/dubbingProcessor';
import {
  setDubbingSessionsRoot,
  recoverSessionDeletions,
  stageSessionDeletion,
  getSessionDir,
  assertSessionAvailable,
} from './dubbing/sessionStore';
import { workItemSessionIds } from './dubbing/workItemSessions';
import { dubbingSessionOwnership } from './dubbing/sessionOwnership';
import { DubbingOperationRegistry } from './dubbing/operationRegistry';
import { DubbingOperationStore } from './dubbing/operationStore';
import { recoverDubbingArtifacts } from './dubbing/recoverArtifacts';
import {
  readConfigDraft,
  writeConfigDraft,
  readCueDraft,
  writeCueDraft,
} from './dubbing/configDraftStore';
import {
  VoicePreviewCache,
  previewCloneIdentity,
} from './dubbing/voicePreviewCache';
import { getClonedVoiceById } from './voiceClone/voiceCloneManager';
import { getTtsProviderById } from './ttsProviderManager';
import { saveWorkItem, getWorkItemById, getWorkItems } from './workItemStore';
import type { WorkItem } from '../../types/workItem';
import type { DubbingConfig, DubbingProgressEvent } from '../../types/dubbing';

interface DubbingResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  cancelled?: boolean;
  recoveryWarning?: string;
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
    speakerIds: cue.speakerIds,
    primarySpeakerId: cue.primarySpeakerId,
    synthesizedVoiceId: cue.synthesizedVoiceId,
    synthesizedInputKey: cue.synthesizedInputKey,
    needsUpdate: cue.needsUpdate,
    status: cue.status,
    overlap: cue.overlap,
    synthesizedMs: cue.finalMs,
    originalMeasuredMs: cue.originalMeasuredMs,
    borrowedMs: cue.borrowedMs,
    appliedSpeed: cue.appliedSpeed,
    requiredFactor: cue.requiredFactor,
    wavPath: cue.wavPath,
    error: cue.error,
  };
}

function sessionView(session: DubbingSession) {
  return {
    sessionId: session.id,
    workItemId: session.workItemId,
    subtitlePath: session.subtitlePath,
    videoPath: session.videoPath,
    mediaDurationMs: session.mediaDurationMs,
    subtitleLanguage: session.subtitleLanguage,
    detectedLanguage: session.detectedLanguage,
    configSnapshot: session.lastConfig,
    cues: session.cues.map(cueView),
    speakers: session.speakers,
    speakerVoiceMap: session.speakerVoiceMap,
    speakerSettings: session.speakerSettings || {},
    speakerSettingsConflicts: session.speakerSettingsConflicts || {},
    speakerVoiceConflicts: session.speakerVoiceConflicts,
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
 * 配音 workItem：导入即创建，角色草稿在首次合成前也能从最近任务恢复。
 * configSnapshot 恒携带 sessionId：最近任务回开按会话恢复行级状态与产物。
 */
function upsertDubbingWorkItem(
  session: DubbingSession,
  status: WorkItem['status'],
  artifacts?: WorkItem['artifacts'],
  durable = false,
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
    proofreadDataFile: session.proofreadDataFile,
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
  saveWorkItem(item, { durable });
  session.workItemId = item.id;
}

export function setupDubbingHandlers(mainWindow: BrowserWindow) {
  const previews = new VoicePreviewCache();
  const ownership = dubbingSessionOwnership;
  const operations = new DubbingOperationRegistry<DubbingResponse>(
    32,
    new DubbingOperationStore(),
  );
  const owners = new Map<number, Electron.WebContents>();
  const ownerEpochs = new Map<number, number>();
  const pendingLoads = new Map<
    string,
    { cancelled: boolean; owner: number; leaseId: string }
  >();
  const loadKey = (owner: number, leaseId: string) => `${owner}:${leaseId}`;
  const watchOwner = (sender: Electron.WebContents) => {
    if (owners.has(sender.id)) return;
    owners.set(sender.id, sender);
    const release = () => {
      ownerEpochs.set(sender.id, (ownerEpochs.get(sender.id) || 0) + 1);
      for (const id of ownership.releaseOwner(sender.id))
        disposeDubbingSession(id, { keepRunning: true });
      for (const pending of pendingLoads.values()) {
        if (pending.owner !== sender.id) continue;
        pending.cancelled = true;
        ownership.retire(sender.id, pending.leaseId);
      }
    };
    sender.once('destroyed', () => {
      release();
      owners.delete(sender.id);
      ownership.forgetWindow(sender.id);
    });
    sender.on('render-process-gone', release);
    sender.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) release();
    });
  };
  const handleOwned = (
    channel: string,
    handler: Parameters<typeof ipcMain.handle>[1],
  ) => {
    ipcMain.handle(channel, async (event, payload) => {
      if (
        !ownership.owns(payload?.sessionId, event.sender.id, payload?.leaseId)
      )
        return {
          success: false,
          error:
            'Dubbing session is open in another window or no longer owned by this editor',
        };
      const execute = async () => {
        let result: DubbingResponse;
        try {
          result = await handler(event, payload);
        } catch (error) {
          result = fail(error);
        }
        // The requesting renderer may have left while work continued in the main process.
        if (
          [
            'dubbing:start',
            'dubbing:resynthesizeCue',
            'dubbing:setMedia',
            'dubbing:export',
          ].includes(channel)
        ) {
          const session = getDubbingSession(payload.sessionId);
          const currentOwner = ownership.owner(payload.sessionId);
          const sender =
            currentOwner === undefined
              ? undefined
              : owners.get(currentOwner.windowId);
          if (session && sender && !sender.isDestroyed()) {
            try {
              sender.send('dubbing:sessionState', {
                session: {
                  ...sessionView(session),
                  leaseId: currentOwner!.leaseId,
                },
                error: result.success ? undefined : result.error,
                exportResult:
                  channel === 'dubbing:export' && result.success
                    ? result.data
                    : undefined,
              });
            } catch {
              // The committed result remains queryable if its recipient closed.
            }
          }
        }
        return result;
      };
      if (
        payload?.requestId !== undefined &&
        ['dubbing:start', 'dubbing:resynthesizeCue', 'dubbing:export'].includes(
          channel,
        )
      ) {
        try {
          const result = await operations.run(channel, payload, async () => {
            try {
              return await execute();
            } catch (error) {
              return fail(error);
            }
          });
          const state = operations.status(payload.sessionId, payload.requestId);
          return {
            ...result,
            ...('persistenceError' in state && state.persistenceError
              ? { recoveryWarning: state.persistenceError }
              : {}),
          };
        } catch (error) {
          return fail(error);
        }
      }
      return execute();
    });
  };
  handleOwned('dubbing:operationStatus', (_event, { sessionId, requestId }) => {
    if (typeof requestId !== 'string' || !requestId || requestId.length > 128)
      throw new Error('Invalid dubbing operation identifier');
    return { success: true, data: operations.status(sessionId, requestId) };
  });
  const previewOwners = new Set<number>();
  handleOwned('dubbing:readCueDraft', (_event, { sessionId }) => ({
    success: true,
    data: readCueDraft(sessionId),
  }));
  handleOwned(
    'dubbing:writeCueDraft',
    (_event, { sessionId, expected, raw }) => ({
      success: true,
      data: writeCueDraft(sessionId, expected, raw),
    }),
  );
  handleOwned('dubbing:saveCueTexts', (_event, { sessionId, edits }) => {
    const session = getDubbingSession(sessionId);
    if (!session) throw new Error('Dubbing session is unavailable');
    saveDubbingCueTexts(session, edits);
    return { success: true, data: sessionView(session) };
  });
  handleOwned('dubbing:readConfigDraft', (_event, { sessionId }) => ({
    success: true,
    data: readConfigDraft(sessionId),
  }));
  handleOwned(
    'dubbing:writeConfigDraft',
    (_event, { sessionId, expected, raw }) => ({
      success: true,
      data: writeConfigDraft(sessionId, expected, raw),
    }),
  );
  ipcMain.handle('dubbing:cancelPreview', (event, { requestId }) => {
    previews.cancel(event.sender.id, requestId);
    return { success: true };
  });
  // 会话持久化根目录：应用数据目录下（dispose 不删除，重开可恢复）
  setDubbingSessionsRoot(
    path.join(app.getPath('userData'), 'dubbing-sessions'),
  );
  recoverSessionDeletions(new Set(getWorkItems().flatMap(workItemSessionIds)));
  recoverDubbingArtifacts(getWorkItems());
  ipcMain.handle('dubbing:missingSessions', (_event, ids: unknown) => {
    if (!Array.isArray(ids) || ids.length > 10000)
      throw new Error('Invalid session list');
    return ids.filter((id) => {
      try {
        assertSessionAvailable(id);
        try {
          fs.statSync(getSessionDir(id));
          return false;
        } catch (error) {
          return error.code === 'ENOENT';
        }
      } catch {
        return false;
      }
    });
  });
  handleOwned('dubbing:setMedia', async (_event, { sessionId, videoPath }) => {
    const session = getDubbingSession(sessionId);
    if (!session)
      return { success: false, error: '会话不存在，请重新加载字幕' };
    try {
      await setDubbingMedia(session, videoPath || undefined);
      return { success: true, data: sessionView(session) };
    } catch (error) {
      return fail(error);
    }
  });

  handleOwned(
    'dubbing:syncVoiceState',
    async (
      _event,
      { sessionId, config }: { sessionId: string; config: DubbingConfig },
    ): Promise<DubbingResponse> => {
      const session = getDubbingSession(sessionId);
      if (!session)
        return { success: false, error: '会话不存在，请重新加载字幕' };
      try {
        saveDubbingConfig(session, config);
        return { success: true, data: sessionView(session) };
      } catch (error) {
        return fail(error);
      }
    },
  );

  const emitProgress = (e: DubbingProgressEvent, cue?: SessionCue) => {
    const owner = ownership.owner(e.taskId);
    const sender = owner === undefined ? undefined : owners.get(owner.windowId);
    if (!sender || sender.isDestroyed()) return;
    sender.send('dubbing:progress', {
      ...e,
      leaseId: owner!.leaseId,
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

  // Inspection must not acquire editing rights or update recent-task metadata.
  ipcMain.handle('dubbing:getSession', (_event, { sessionId }) => {
    try {
      const restored = restoreDubbingSession(sessionId, { cache: false });
      return restored.kind === 'ok'
        ? { success: true, data: sessionView(restored.session) }
        : { success: false, error: `Dubbing session ${restored.kind}` };
    } catch (error) {
      return fail(error);
    }
  });

  // 加载字幕（+ 可选视频）创建会话；携 sessionId 时优先恢复既有会话。
  ipcMain.handle(
    'dubbing:loadSubtitle',
    async (
      event,
      {
        subtitlePath,
        videoPath,
        sessionId,
        rebuildSessionId,
        workItemId,
        proofreadDataFile,
        leaseId,
      }: {
        subtitlePath: string;
        leaseId: string;
        videoPath?: string;
        /** 尝试恢复的既有会话（最近任务回开携带） */
        sessionId?: string;
        /** 用户确认重建：删除旧会话数据后新建 */
        rebuildSessionId?: string;
        /** 关联的工作项（恢复/重建时保持同一条最近任务记录） */
        workItemId?: string;
        /** 流水线/衔接入口可直接传递已知 sidecar；普通导入会自动发现。 */
        proofreadDataFile?: string;
      },
    ): Promise<DubbingResponse> => {
      const owner = event.sender.id;
      watchOwner(event.sender);
      const epoch = ownerEpochs.get(owner) || 0;
      if (typeof leaseId !== 'string' || !leaseId || leaseId.length > 128)
        return {
          success: false,
          error: 'A valid dubbing editor lease is required',
        };
      if (ownership.isRetired(owner, leaseId))
        return {
          success: false,
          error: 'Dubbing editor lease has been released',
        };
      if (sessionId && rebuildSessionId && sessionId !== rebuildSessionId)
        return {
          success: false,
          error: 'Conflicting dubbing session identifiers',
        };
      const existingId = sessionId || rebuildSessionId;
      const key = loadKey(owner, leaseId);
      if (pendingLoads.has(key))
        return { success: false, error: 'Dubbing editor is already loading' };
      if (existingId && !ownership.acquire(existingId, owner, leaseId))
        return { success: true, data: { locked: true, sessionId: existingId } };
      const pending = { cancelled: false, owner, leaseId };
      pendingLoads.set(key, pending);
      try {
        const existingWorkItemId =
          workItemId ||
          (existingId &&
            getWorkItems().find(
              (item) =>
                item.type === 'dubbing' &&
                item.configSnapshot?.sessionId === existingId,
            )?.id);
        // 恢复路径：字幕 hash 一致 → 直接恢复行级状态与产物
        if (sessionId) {
          // Unreadable receipts cannot be treated as operations that never ran.
          const operationRecovery = operations.latest(sessionId);
          const restored = restoreDubbingSession(sessionId);
          if (restored.kind === 'ok') {
            restored.session.workItemId =
              existingWorkItemId || restored.session.workItemId;
            const workItem =
              restored.session.workItemId &&
              getWorkItemById(restored.session.workItemId);
            const recoveredExport =
              operationRecovery?.status === 'complete' &&
              operationRecovery.channel === 'dubbing:export' &&
              operationRecovery.result?.success
                ? (operationRecovery.result.data as {
                    outputPath?: string;
                    shiftedSubtitlePath?: string;
                  })
                : undefined;
            const restoreExport =
              workItem?.type === 'dubbing' &&
              typeof recoveredExport?.outputPath === 'string' &&
              fs.existsSync(recoveredExport.outputPath);
            upsertDubbingWorkItem(
              restored.session,
              restoreExport
                ? 'done'
                : (restored.session.workItemId &&
                    getWorkItemById(restored.session.workItemId)?.status) ||
                    'waiting',
              restoreExport
                ? [
                    {
                      kind:
                        path
                          .extname(recoveredExport.outputPath)
                          .toLowerCase() === '.wav' ||
                        path
                          .extname(recoveredExport.outputPath)
                          .toLowerCase() === '.mp3'
                          ? 'audio'
                          : 'video',
                      path: recoveredExport.outputPath,
                    },
                    ...(recoveredExport.shiftedSubtitlePath &&
                    fs.existsSync(recoveredExport.shiftedSubtitlePath)
                      ? [
                          {
                            kind: 'subtitle',
                            path: recoveredExport.shiftedSubtitlePath,
                          },
                        ]
                      : []),
                  ]
                : undefined,
              true,
            );
            return {
              success: true,
              data: {
                ...sessionView(restored.session),
                leaseId,
                restored: true,
                configSnapshot: restored.session.lastConfig,
                operationRecovery,
              },
            };
          }
          if (restored.kind === 'stale') {
            // 字幕已变：不静默重建，交由用户确认（保留旧产物直至确认）
            return {
              success: true,
              data: {
                stale: true,
                leaseId,
                sessionId,
                workItemId: existingWorkItemId,
                subtitlePath: restored.subtitlePath,
                videoPath: restored.videoPath,
              },
            };
          }
          ownership.release(sessionId, owner, leaseId);
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
          if (existingId) ownership.release(existingId, owner, leaseId);
          return { success: false, error: '字幕文件不存在' };
        }
        if (videoPath && !fs.existsSync(videoPath)) {
          if (existingId) ownership.release(existingId, owner, leaseId);
          return { success: false, error: '视频文件不存在' };
        }
        const session = await createDubbingSession(
          subtitlePath,
          videoPath,
          proofreadDataFile,
        );
        if (
          event.sender.isDestroyed() ||
          pending.cancelled ||
          epoch !== (ownerEpochs.get(owner) || 0)
        ) {
          deleteDubbingSessionData(session.id);
          throw new Error('Dubbing editor closed while loading');
        }
        ownership.acquire(session.id, owner, leaseId);
        session.workItemId = existingWorkItemId;
        let replaced: ReturnType<typeof stageSessionDeletion> | undefined;
        try {
          if (
            rebuildSessionId &&
            !getWorkItems().some(
              (item) =>
                item.id !== existingWorkItemId &&
                workItemSessionIds(item).includes(rebuildSessionId),
            )
          )
            replaced = stageSessionDeletion([rebuildSessionId]);
          upsertDubbingWorkItem(session, 'waiting', undefined, true);
          session.pendingTaskLink = false;
        } catch (error) {
          replaced?.rollback();
          ownership.release(session.id, owner, leaseId);
          deleteDubbingSessionData(session.id);
          throw error;
        }
        // Keep the old project until both the new session and its task link exist.
        if (rebuildSessionId) {
          ownership.release(rebuildSessionId, owner, leaseId);
          if (replaced) forgetDubbingSession(rebuildSessionId);
          replaced?.commit();
          if (replaced)
            for (const window of BrowserWindow.getAllWindows()) {
              try {
                window.webContents.send('dubbing:sessionsDeleted', [
                  rebuildSessionId,
                ]);
              } catch {
                /* closed window */
              }
            }
        }
        return { success: true, data: { ...sessionView(session), leaseId } };
      } catch (error) {
        if (existingId && epoch === (ownerEpochs.get(owner) || 0))
          ownership.release(existingId, owner, leaseId);
        logMessage(`dubbing load failed: ${error}`, 'error');
        return fail(error);
      } finally {
        pendingLoads.delete(key);
      }
    },
  );

  // 批量合成（全部待处理行）。
  handleOwned(
    'dubbing:start',
    async (
      _event,
      {
        sessionId,
        config,
        force,
        staleOnly,
        speakerId,
      }: {
        sessionId: string;
        config: DubbingConfig;
        force?: boolean;
        staleOnly?: boolean;
        speakerId?: number;
      },
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
          { force, staleOnly, speakerId },
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
        // （发起批量的 invoke promise 随页面卸载丢失，事件是唯一通知通道）。
        // stage='done' 仅表示「批量已结束」；percent 取真实完成度，
        // 取消/失败场景不再谎报 100%。
        const doneCount = session.cues.filter(
          (c) =>
            !c.needsUpdate && (c.status === 'done' || c.status === 'accepted'),
        ).length;
        emitProgress({
          taskId: session.id,
          stage: 'done',
          percent:
            session.cues.length > 0
              ? Math.round((doneCount / session.cues.length) * 100)
              : 100,
        });
      }
    },
  );

  // 角色默认音色：只标记继承该角色且已有产物的 cue 为需要更新。
  handleOwned(
    'dubbing:setSpeakerVoice',
    async (
      _event,
      {
        sessionId,
        speakerId,
        voiceId,
        globalVoiceId,
        config,
      }: {
        sessionId: string;
        speakerId: number;
        voiceId: string;
        globalVoiceId: string;
        config?: DubbingConfig;
      },
    ): Promise<DubbingResponse> => {
      const session = getDubbingSession(sessionId);
      if (!session)
        return { success: false, error: '会话不存在，请重新加载字幕' };
      try {
        if (session.running) throw new Error('配音正在进行中，请稍后修改音色');
        const result = setSpeakerVoiceMapping(
          session,
          speakerId,
          voiceId,
          globalVoiceId,
          config,
        );
        return {
          success: true,
          data: {
            ...result,
            speakerVoiceMap: session.speakerVoiceMap,
            speakerVoiceConflicts: session.speakerVoiceConflicts,
            cues: session.cues.map(cueView),
          },
        };
      } catch (error) {
        return fail(error);
      }
    },
  );

  handleOwned(
    'dubbing:setSpeakerSettings',
    async (_event, { sessionId, speakerId, settings, config }) => {
      const session = getDubbingSession(sessionId);
      if (!session)
        return { success: false, error: '会话不存在，请重新加载字幕' };
      try {
        setSpeakerSettings(session, speakerId, settings, config);
        return {
          success: true,
          data: {
            speakerSettings: session.speakerSettings,
            speakerSettingsConflicts: session.speakerSettingsConflicts,
            cues: session.cues.map(cueView),
          },
        };
      } catch (error) {
        return fail(error);
      }
    },
  );

  // 单行重生成（可携新文本 / 新 voice）。
  handleOwned(
    'dubbing:resynthesizeCue',
    async (
      _event,
      {
        sessionId,
        index,
        text,
        voiceId,
        config,
        expectedCue,
      }: {
        sessionId: string;
        index: number;
        text?: string;
        voiceId?: string;
        config: DubbingConfig;
        expectedCue?: {
          text: string;
          wavPath?: string;
          synthesizedInputKey?: string;
          voiceId?: string;
        };
      },
    ): Promise<DubbingResponse> => {
      const session = getDubbingSession(sessionId);
      if (!session)
        return { success: false, error: '会话不存在，请重新加载字幕' };
      try {
        const cue = await resynthesizeCue(
          session,
          index,
          { text, voiceId, expectedCue },
          config,
        );
        return { success: true, data: cueView(cue) };
      } catch (error) {
        return fail(error);
      }
    },
  );

  // 行级 voice 覆盖仅记录（pending 行,批量时生效）。
  handleOwned(
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

  // Explicit silence borrowing; no audio mutation and no following-cue shifts.
  handleOwned(
    'dubbing:borrowSilence',
    async (
      _event,
      {
        sessionId,
        index,
        config,
      }: { sessionId: string; index: number; config: DubbingConfig },
    ): Promise<DubbingResponse> => {
      const session = getDubbingSession(sessionId);
      if (!session)
        return { success: false, error: '会话不存在，请重新加载字幕' };
      try {
        const cue = borrowFollowingSilence(session, index, config);
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
      event,
      {
        engine,
        voiceId,
        text,
        cloneQuality,
        sessionId,
        language,
        speakerSettings,
        requestId,
      }: {
        engine: DubbingConfig['engine'];
        voiceId: string;
        text?: string;
        cloneQuality?: DubbingConfig['cloneQuality'];
        sessionId?: string;
        language?: string;
        speakerSettings?: import('../../types/dubbing').DubbingSpeakerSettings;
        requestId?: string;
      },
    ): Promise<DubbingResponse> => {
      try {
        const session = sessionId ? getDubbingSession(sessionId) : undefined;
        const owner = event.sender.id;
        if (!previewOwners.has(owner)) {
          previewOwners.add(owner);
          event.sender.once('destroyed', () => {
            previews.dispose(owner);
            previewOwners.delete(owner);
          });
        }
        const options = {
          cloneQuality,
          language,
          speakerSettings,
          subtitleLanguage: session?.subtitleLanguage,
          detectedLanguage: session?.detectedLanguage,
          maxDurationMs: 3000,
        };
        const sample =
          typeof text === 'string'
            ? Array.from(text).slice(0, 120).join('')
            : undefined;
        const provider =
          engine.kind === 'cloud'
            ? getTtsProviderById(engine.providerId)
            : undefined;
        const r = await previews.get(
          owner,
          requestId || randomUUID(),
          {
            engine,
            voiceId,
            sample,
            options,
            provider,
            clone:
              engine.kind === 'local'
                ? previewCloneIdentity(getClonedVoiceById(voiceId))
                : undefined,
          },
          (signal) =>
            previewVoice(engine, voiceId, sample, {
              ...options,
              signal,
              onPcm: requestId
                ? (pcm, sampleRate) => {
                    if (!signal.aborted && !event.sender.isDestroyed())
                      event.sender.send('dubbing:previewChunk', {
                        requestId,
                        pcm,
                        sampleRate,
                      });
                  }
                : undefined,
            }),
        );
        return { success: true, data: r.wavPath };
      } catch (error) {
        return fail(error);
      }
    },
  );

  // 导出（拼接 → 背景音/输出形态 → 可选顺延字幕）。
  handleOwned(
    'dubbing:export',
    async (
      _event,
      {
        sessionId,
        config,
        requestId,
      }: { sessionId: string; config: DubbingConfig; requestId?: string },
    ): Promise<DubbingResponse> => {
      const session = getDubbingSession(sessionId);
      if (!session)
        return { success: false, error: '会话不存在，请重新加载字幕' };
      let powerSaveAcquired = false;
      try {
        acquireTaskPowerSaveBlocker(DUBBING_POWER_SAVE_REASON);
        powerSaveAcquired = true;
        const result = await exportDubbing(
          session,
          config,
          (e) => emitProgress(e),
          requestId
            ? (state) =>
                operations.checkpointPublication(sessionId, requestId, state)
            : undefined,
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
  handleOwned(
    'dubbing:cancel',
    async (_event, { sessionId }: { sessionId: string }) => {
      const session = getDubbingSession(sessionId);
      if (!session) return { success: true, data: false };
      return { success: true, data: cancelDubbing(session) };
    },
  );

  // Leaving an editor never implicitly cancels work owned by the main process.
  ipcMain.handle(
    'dubbing:disposeSession',
    async (
      event,
      {
        sessionId,
        leaseId,
      }: { sessionId?: string; leaseId: string; keepRunning?: boolean },
    ) => {
      if (typeof leaseId !== 'string' || !leaseId || leaseId.length > 128)
        return { success: true, data: false };
      // Retain released tokens until this window closes, including cancellations
      // delivered before a delayed load. Old pages must never reacquire a lease.
      if (sessionId && !ownership.owns(sessionId, event.sender.id, leaseId))
        return { success: true, data: false };
      const pending = pendingLoads.get(loadKey(event.sender.id, leaseId));
      if (pending) pending.cancelled = true;
      const released = ownership.retire(event.sender.id, leaseId);
      for (const id of released)
        disposeDubbingSession(id, { keepRunning: true });
      return { success: true, data: released.length > 0 || !!pending };
    },
  );

  logMessage('配音 IPC 处理函数已注册', 'info');
}
