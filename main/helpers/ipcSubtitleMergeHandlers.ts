/**
 * 字幕合并功能 IPC 处理函数
 */

import { ipcMain, dialog, BrowserWindow, shell } from 'electron';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { logMessage } from './storeManager';
import {
  getVideoInfo,
  generateOutputPath,
  getSubtitleFormat,
  countSubtitles,
  buildAssForSubtitle,
} from './subtitleMerger';
import {
  enqueueCompose,
  cancelComposeJob,
  getComposeQueueSnapshot,
  setComposeEventListeners,
} from './compose/composeQueue';
import {
  loadFontData,
  embeddedFontContext,
  listSubtitleFonts,
  prepareSubtitleFonts,
} from './fontResolver';
import { getHwAccelInfo } from './hwEncoderDetector';
import { store } from './store';
import type { StoreType } from './store/types';
import type { SubtitleStyle } from '../../types/subtitleMerge';
import { assertValidSubtitleStyle } from '../../types/subtitleStyleValidation';
import type {
  ComposeConfig,
  MergeConfig,
  SubtitleMergeResponse,
  VideoInfo,
  SubtitleInfo,
  HwAccelInfo,
  UserStylePreset,
} from '../../types/subtitleMerge';

function readStylePresets(): UserStylePreset[] {
  const list = store.get('mergeStylePresets');
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error('Invalid saved style preset list');
  return list;
}

/** MergeConfig（渲染层合成面板契约）→ ComposeConfig（统一合成引擎矩阵） */
function mergeConfigToComposeConfig(
  config: MergeConfig,
  outputPath: string,
): ComposeConfig {
  return {
    videoPath: config.videoPath,
    outputPath,
    subtitle:
      config.outputMode === 'softmux'
        ? { mode: 'soft', subtitlePath: config.subtitlePath }
        : {
            mode: 'hard',
            subtitlePath: config.subtitlePath,
            style: config.style,
            videoQuality: config.videoQuality,
            encoderMode: config.encoderMode,
          },
    audio: config.audioTrack
      ? {
          mode: config.audioTrack.mode,
          trackPath: config.audioTrack.trackPath,
          duckRatio: config.audioTrack.duckRatio,
        }
      : { mode: 'keep' },
  };
}

/**
 * 设置字幕合并相关的 IPC 处理函数
 */
export function setupSubtitleMergeHandlers(
  mainWindow: BrowserWindow,
  rendererUrl = mainWindow.webContents.getURL(),
) {
  const ownerUrl = new URL(rendererUrl);
  const ownerSession = mainWindow.webContents.session;
  // 合成队列事件出口：进度沿用既有 subtitleMerge:progress 通道（增量携带
  // jobId/source），队列快照走 compose:queue（排队位置展示）
  setComposeEventListeners({
    onProgress: (progress) => {
      broadcast('subtitleMerge:progress', progress);
    },
    onQueueChange: (snapshot) => {
      broadcast('compose:queue', snapshot);
    },
  });
  function broadcast(channel: string, value: unknown) {
    for (const window of BrowserWindow.getAllWindows()) {
      // Only application windows in the same session receive local job paths.
      try {
        if (window.webContents.session !== ownerSession) continue;
        const target = new URL(window.webContents.getURL());
        if (
          ownerUrl.protocol !== target.protocol ||
          ownerUrl.host !== target.host
        )
          continue;
        window.webContents.send(channel, value);
      } catch {
        /* A closing window must not interrupt the export or other listeners. */
      }
    }
  }

  // 获取视频信息
  ipcMain.handle(
    'subtitleMerge:getVideoInfo',
    async (event, { videoPath }): Promise<SubtitleMergeResponse<VideoInfo>> => {
      try {
        if (!fs.existsSync(videoPath)) {
          return { success: false, error: '视频文件不存在' };
        }
        const info = await getVideoInfo(videoPath);
        return { success: true, data: info };
      } catch (error) {
        logMessage(`获取视频信息失败: ${error}`, 'error');
        return { success: false, error: `获取视频信息失败: ${error}` };
      }
    },
  );

  // 获取字幕文件信息
  ipcMain.handle(
    'subtitleMerge:getSubtitleInfo',
    async (
      event,
      { subtitlePath },
    ): Promise<SubtitleMergeResponse<SubtitleInfo>> => {
      try {
        if (!fs.existsSync(subtitlePath)) {
          return { success: false, error: '字幕文件不存在' };
        }

        const count = await countSubtitles(subtitlePath);
        const format = getSubtitleFormat(subtitlePath);

        return {
          success: true,
          data: {
            path: subtitlePath,
            fileName: path.basename(subtitlePath),
            count,
            format,
          },
        };
      } catch (error) {
        logMessage(`获取字幕信息失败: ${error}`, 'error');
        return { success: false, error: `获取字幕信息失败: ${error}` };
      }
    },
  );

  // 开始合并字幕：入列统一合成队列，作业终态时 resolve（IPC 契约不变）
  ipcMain.handle(
    'subtitleMerge:startMerge',
    async (
      event,
      config: MergeConfig,
    ): Promise<SubtitleMergeResponse<string>> => {
      try {
        if (!fs.existsSync(config.videoPath)) {
          return { success: false, error: '视频文件不存在' };
        }
        if (!fs.existsSync(config.subtitlePath)) {
          return { success: false, error: '字幕文件不存在' };
        }
        if (config.audioTrack && !fs.existsSync(config.audioTrack.trackPath)) {
          return { success: false, error: '配音音轨文件不存在' };
        }

        // 如果没有指定输出路径，自动生成
        const outputPath =
          config.outputPath || generateOutputPath(config.videoPath);

        // 确保输出目录存在
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
          await fs.promises.mkdir(outputDir, { recursive: true });
        }

        const { jobId, done } = enqueueCompose(
          mergeConfigToComposeConfig(config, outputPath),
          'subtitleMerge',
          { requestId: config.requestId },
        );
        if (config.requestId && !event.sender.isDestroyed()) {
          try {
            event.sender.send('subtitleMerge:queued', {
              requestId: config.requestId,
              jobId,
            });
          } catch {
            /* Closing the renderer does not cancel its queued export. */
          }
        }
        const result = await done;
        if (result.cancelled) {
          return { success: true, cancelled: true };
        }
        if (result.success && result.outputPath) {
          return { success: true, data: result.outputPath };
        }
        logMessage(`合并失败: ${result.error}`, 'error');
        return { success: false, error: `合并失败: ${result.error}` };
      } catch (error) {
        logMessage(`合并失败: ${error}`, 'error');
        return { success: false, error: `合并失败: ${error}` };
      }
    },
  );

  // 取消合成：指定 jobId 取消对应作业（排队即出队、运行中 kill ffmpeg）；
  // 未指定时取消合成面板来源的活动作业（既有无参契约）
  ipcMain.handle(
    'subtitleMerge:cancelMerge',
    async (
      event,
      args?: { jobId?: string },
    ): Promise<SubtitleMergeResponse<boolean>> => {
      const cancelled = cancelComposeJob(args?.jobId);
      return { success: true, data: cancelled };
    },
  );

  // 合成队列快照（挂载时初始化排队状态展示；增量变更走 compose:queue 事件）
  ipcMain.handle(
    'subtitleMerge:getQueue',
    async (): Promise<
      SubtitleMergeResponse<ReturnType<typeof getComposeQueueSnapshot>>
    > => {
      return { success: true, data: getComposeQueueSnapshot() };
    },
  );

  // 硬件编码器探测结果（首次调用触发试编码探测，之后命中会话缓存）
  ipcMain.handle(
    'subtitleMerge:getHwAccelInfo',
    async (): Promise<SubtitleMergeResponse<HwAccelInfo>> => {
      try {
        const info = await getHwAccelInfo();
        return { success: true, data: info };
      } catch (error) {
        logMessage(`获取硬件加速信息失败: ${error}`, 'error');
        return { success: false, error: `获取硬件加速信息失败: ${error}` };
      }
    },
  );

  // 合成输出偏好（outputMode/videoQuality/encoderMode 跨重启记忆）
  ipcMain.handle(
    'subtitleMerge:getPreferences',
    async (): Promise<SubtitleMergeResponse<StoreType['mergePreferences']>> => {
      return { success: true, data: store.get('mergePreferences') };
    },
  );

  ipcMain.handle(
    'subtitleMerge:setPreferences',
    async (
      event,
      prefs: StoreType['mergePreferences'],
    ): Promise<SubtitleMergeResponse<boolean>> => {
      const prev = store.get('mergePreferences');
      store.set('mergePreferences', { ...prev, ...prefs });
      return { success: true, data: true };
    },
  );

  // ── 用户样式预设（我的样式）：合成工作台保存/删除，任务向导样式选择共用 ──
  ipcMain.handle(
    'subtitleMerge:listStylePresets',
    async (): Promise<SubtitleMergeResponse<UserStylePreset[]>> => {
      return { success: true, data: readStylePresets() };
    },
  );

  // 按 id 幂等 upsert（无 id 新建）；同名不去重——名字只是标签，允许用户自理
  ipcMain.handle(
    'subtitleMerge:saveStylePreset',
    async (
      event,
      payload: { id?: string; name: string; style: SubtitleStyle },
    ): Promise<SubtitleMergeResponse<UserStylePreset>> => {
      const name = payload?.name?.trim();
      if (!name || !payload?.style) {
        return { success: false, error: '样式名称与内容不能为空' };
      }
      if (
        payload.id !== undefined &&
        (typeof payload.id !== 'string' || !payload.id.trim())
      )
        return { success: false, error: 'Invalid style preset id' };
      assertValidSubtitleStyle(payload.style);
      const now = Date.now();
      const list = readStylePresets();
      const index = payload.id
        ? list.findIndex((p) => p.id === payload.id)
        : -1;
      const saved: UserStylePreset = {
        id: payload.id || randomUUID(),
        name,
        style: payload.style,
        createdAt: index >= 0 ? (list[index].createdAt ?? now) : now,
        updatedAt: now,
      };
      if (index >= 0) list[index] = saved;
      else list.push(saved);
      store.set('mergeStylePresets', list);
      return { success: true, data: saved };
    },
  );

  ipcMain.handle(
    'subtitleMerge:deleteStylePreset',
    async (event, id: string): Promise<SubtitleMergeResponse<boolean>> => {
      const list = readStylePresets();
      const next = list.filter((p) => p.id !== id);
      if (next.length === list.length) {
        return { success: true, data: true };
      }
      store.set('mergeStylePresets', next);
      return { success: true, data: true };
    },
  );

  // 选择输出路径
  ipcMain.handle(
    'subtitleMerge:selectOutputPath',
    async (event, { defaultPath }): Promise<SubtitleMergeResponse<string>> => {
      try {
        const result = await dialog.showSaveDialog(mainWindow, {
          title: '选择保存位置',
          defaultPath: defaultPath || undefined,
          filters: [
            { name: 'Video Files', extensions: ['mp4', 'mkv', 'avi', 'mov'] },
          ],
        });

        if (result.canceled || !result.filePath) {
          return { success: true, cancelled: true };
        }

        return { success: true, data: result.filePath };
      } catch (error) {
        logMessage(`选择输出路径失败: ${error}`, 'error');
        return { success: false, error: `选择输出路径失败: ${error}` };
      }
    },
  );

  // 生成默认输出路径
  ipcMain.handle(
    'subtitleMerge:generateOutputPath',
    async (
      event,
      { videoPath, suffix },
    ): Promise<SubtitleMergeResponse<string>> => {
      try {
        const outputPath = generateOutputPath(videoPath, suffix);
        return { success: true, data: outputPath };
      } catch (error) {
        return { success: false, error: `生成输出路径失败: ${error}` };
      }
    },
  );

  // 生成预览用 ASS 内容（与烧录共用同一生成逻辑，保证所见即所得）
  ipcMain.handle(
    'subtitleMerge:buildPreviewAss',
    async (
      event,
      {
        subtitlePath,
        sampleText,
        style,
      }: {
        subtitlePath?: string | null;
        sampleText?: string;
        style: SubtitleStyle;
      },
    ): Promise<SubtitleMergeResponse<string>> => {
      try {
        let content: string;
        let pathForFormat: string;
        if (subtitlePath) {
          content = await fs.promises.readFile(subtitlePath, 'utf-8');
          pathForFormat = subtitlePath;
        } else {
          // 未选字幕文件：用样例文字生成一条全程显示的字幕（调样式用）
          const text = (sampleText || '字幕预览效果').replace(/\r\n?/g, '\n');
          content = `1\n00:00:00,000 --> 99:00:00,000\n${text}\n`;
          pathForFormat = 'sample.srt';
        }
        await prepareSubtitleFonts();
        const {
          assContent,
          effectiveStyle,
          fontNames,
          embeddedFonts,
          fontSubstituted,
          translateY,
        } = buildAssForSubtitle(content, pathForFormat, style);
        return {
          success: true,
          data: assContent,
          translateY,
          fontName: effectiveStyle.fontName,
          fontNames,
          fontSubstituted,
          embeddedFonts,
        } as SubtitleMergeResponse<string> & {
          fontName: string;
          fontNames: string[];
          fontSubstituted: boolean;
        };
      } catch (error) {
        logMessage(`生成预览 ASS 失败: ${error}`, 'error');
        return { success: false, error: `生成预览 ASS 失败: ${error}` };
      }
    },
  );

  // 读取字体文件数据（供 JASSUB WASM 预览加载真实字形；WASM 无法直接访问系统字体）
  const subtitleFonts = async (subtitlePath?: string | null) =>
    subtitlePath && /\.(ass|ssa)$/i.test(subtitlePath)
      ? embeddedFontContext(await fs.promises.readFile(subtitlePath, 'utf8'))
      : [];
  ipcMain.handle(
    'subtitleMerge:listFonts',
    async (_event, payload?: { subtitlePath?: string }) => ({
      success: true,
      data: await listSubtitleFonts(await subtitleFonts(payload?.subtitlePath)),
    }),
  );
  ipcMain.handle(
    'subtitleMerge:getFontData',
    async (
      event,
      { fontName, subtitlePath }: { fontName: string; subtitlePath?: string },
    ): Promise<
      SubtitleMergeResponse<{
        fontName: string;
        fullName: string;
        postscriptName: string;
        data: Uint8Array;
        variants: Uint8Array[];
      }>
    > => {
      try {
        await prepareSubtitleFonts();
        const context = await subtitleFonts(subtitlePath);
        const resolved = loadFontData(fontName, context);
        if (!resolved) {
          return {
            success: false,
            error: `无法定位字体文件: ${fontName}`,
          };
        }
        return {
          success: true,
          data: {
            fontName: resolved.fontName,
            fullName: resolved.filePath ? resolved.fullName : '',
            postscriptName: resolved.filePath ? resolved.postscriptName : '',
            variants: resolved.variants.map((data) => new Uint8Array(data)),
            data: new Uint8Array(resolved.data),
          },
        };
      } catch (error) {
        logMessage(`读取字体数据失败: ${error}`, 'error');
        return { success: false, error: `读取字体数据失败: ${error}` };
      }
    },
  );

  // 打开输出文件所在目录
  ipcMain.handle(
    'subtitleMerge:openOutputFolder',
    async (event, { filePath }): Promise<SubtitleMergeResponse<boolean>> => {
      try {
        shell.showItemInFolder(filePath);
        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: `打开目录失败: ${error}` };
      }
    },
  );

  logMessage('字幕合并 IPC 处理函数已注册', 'info');
}
