/**
 * 声音克隆 IPC（voiceClone: 命名空间）：invoke 统一返回 `{success, data?, error?}`
 * （形制 ipcDubbingHandlers）。分析会话（帧级数据）驻留 main 内存，跨 IPC 只传
 * 会话 id 与轻量视图；向导关闭/换素材时 disposeAnalysis 释放。
 */
import { ipcMain, BrowserWindow, dialog, systemPreferences } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { logMessage } from './storeManager';
import { ensureTempDir } from './fileUtils';
import { TaskCancelledError } from './taskContext';
import { parseSubtitleCues, detectSubtitleFormat } from './subtitleFormats';
import {
  analyzeCloneSource,
  analysisView,
  denoiseRangePreview,
  getCloneAnalysisSession,
  disposeCloneAnalysisSession,
  inspectCloneRange,
  prepareCloneReference,
} from './voiceClone/cloneAudioPipeline';
import { transcribeReferenceRange } from './voiceClone/referenceTranscriber';
import {
  getClonedVoices,
  getClonedVoiceById,
  getClonedVoiceDir,
  newClonedVoiceId,
  removeClonedVoice,
  renameClonedVoice,
  saveClonedVoice,
} from './voiceClone/voiceCloneManager';
import { previewVoice } from './dubbing/dubbingProcessor';
import { getTtsProviderById, getTtsProviders } from './ttsProviderManager';
import {
  trainVolcCloneVoice,
  queryVolcCloneStatus,
} from '../service/tts/volcengineVoiceClone';
import {
  addElevenVoice,
  deleteElevenVoice,
} from '../service/tts/elevenlabsVoiceClone';
import {
  CLONE_TARGET_RANGES,
  SVOICE_EXT,
  buildSvoicePackage,
  dominantTextLanguage,
  parseSvoicePackage,
  type ClonedVoice,
  type VoiceCloneEngine,
} from '../../types/voiceClone';
import {
  TTS_ELEVENLABS,
  TTS_VOLCENGINE,
  isTtsProviderConfigured,
} from '../../types/ttsProvider';

interface VoiceCloneResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  cancelled?: boolean;
}

function fail(error: unknown): VoiceCloneResponse {
  if (error instanceof TaskCancelledError) {
    return { success: true, cancelled: true };
  }
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

/** 克隆音色对应的本地模型（zipvoice 双语克隆）。 */
const ZIPVOICE_MODEL_ID = 'zipvoice-distill-zh-en';

/** 火山训练轮询：3s × 30 ≈ 90s，超窗以 training 入库不阻塞。 */
const VOLC_POLL_INTERVAL_MS = 3000;
const VOLC_POLL_MAX_TRIES = 30;

/** 试听样本固定文本（按音色语言）。 */
function sampleText(language: 'zh' | 'en'): string {
  return language === 'en'
    ? 'Hello, this is my cloned voice. Nice to meet you.'
    : '你好，这是我的克隆音色，很高兴认识你。';
}

/** 创建/重生成试听样本：previewVoice 同链路合成到临时 wav，再归档进音色目录。 */
async function synthesizeSampleFor(voice: ClonedVoice): Promise<string> {
  // 云端克隆（火山/EL）走对应 provider 通道 + 云端音色 id；zipvoice 走本地。
  const r =
    voice.engine !== 'zipvoice'
      ? await previewVoice(
          { kind: 'cloud', providerId: voice.providerId! },
          voice.speakerId!,
          sampleText(voice.language),
        )
      : await previewVoice(
          { kind: 'local', modelId: ZIPVOICE_MODEL_ID },
          voice.id,
          sampleText(voice.language),
        );
  const dest = path.join(getClonedVoiceDir(voice.id), 'sample.wav');
  fs.copyFileSync(r.wavPath, dest);
  try {
    fs.unlinkSync(r.wavPath);
  } catch {
    /* ignore */
  }
  return dest;
}

/** EL 克隆的 provider 前置校验（合成 Key 即克隆 Key）。 */
function requireElevenCloneProvider(providerId: string | undefined) {
  const provider = getTtsProviderById(providerId);
  if (!provider || provider.type !== TTS_ELEVENLABS) {
    throw new Error('请先在「配音服务」页配置 ElevenLabs 实例');
  }
  if (!isTtsProviderConfigured(provider)) {
    throw new Error('ElevenLabs 实例未配置完整，请先补齐 API Key');
  }
  return provider;
}

/** 火山克隆的 provider 前置校验：合成 Key + 训练双凭据齐备。 */
function requireVolcCloneProvider(providerId: string | undefined) {
  const provider = getTtsProviderById(providerId);
  if (!provider || provider.type !== TTS_VOLCENGINE) {
    throw new Error('请先在「配音服务」页配置火山引擎豆包实例');
  }
  if (!String(provider.apiKey ?? '').trim()) {
    throw new Error('豆包实例缺少合成 API Key，请先完成配置');
  }
  if (
    !String(provider.appId ?? '').trim() ||
    !String(provider.accessToken ?? '').trim()
  ) {
    throw new Error(
      '豆包声音复刻: 缺少训练凭据。请在「配音服务」页豆包实例中填写 APP ID 与 Access Token',
    );
  }
  return provider;
}

/** 轮询训练状态直至就绪/失败/超窗（剩余训练次数随最后一次响应回传）。 */
async function pollVolcTraining(
  provider: ReturnType<typeof requireVolcCloneProvider>,
  speakerId: string,
): Promise<{
  state: 'ready' | 'training' | 'failed';
  trainingTimesLeft: number | null;
}> {
  let trainingTimesLeft: number | null = null;
  for (let i = 0; i < VOLC_POLL_MAX_TRIES; i += 1) {
    await new Promise((r) => setTimeout(r, VOLC_POLL_INTERVAL_MS));
    try {
      const r = await queryVolcCloneStatus(provider, speakerId);
      if (r.trainingTimesLeft != null) trainingTimesLeft = r.trainingTimesLeft;
      if (r.state !== 'training') return { state: r.state, trainingTimesLeft };
    } catch (e) {
      logMessage(`volc clone status poll failed: ${e}`, 'warning');
    }
  }
  return { state: 'training', trainingTimesLeft };
}

export function setupVoiceCloneHandlers(mainWindow: BrowserWindow) {
  // 选择克隆素材（音频或视频文件）。
  ipcMain.handle('voiceClone:pickSource', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        {
          name: 'Audio/Video',
          extensions: [
            'mp3',
            'wav',
            'm4a',
            'flac',
            'aac',
            'ogg',
            'opus',
            'mp4',
            'mkv',
            'avi',
            'mov',
            'webm',
            'flv',
            'ts',
          ],
        },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, cancelled: true };
    }
    return { success: true, data: result.filePaths[0] };
  });

  // 麦克风权限前置请求（darwin TCC 弹窗；其余平台无系统级门槛，直通）。
  ipcMain.handle('voiceClone:requestMicAccess', async () => {
    if (process.platform !== 'darwin') return { success: true, data: true };
    try {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      if (status === 'granted') return { success: true, data: true };
      const granted = await systemPreferences.askForMediaAccess('microphone');
      return { success: true, data: granted };
    } catch (error) {
      logMessage(`voiceClone mic access failed: ${error}`, 'warning');
      return { success: true, data: false };
    }
  });

  // 向导录音落盘：webm/opus 字节 → 临时目录，返回路径作为分析 sourcePath。
  ipcMain.handle(
    'voiceClone:saveRecording',
    async (
      _event,
      { buffer }: { buffer: ArrayBuffer | Uint8Array },
    ): Promise<VoiceCloneResponse> => {
      try {
        if (!buffer || buffer.byteLength === 0) {
          return { success: false, error: '录音数据为空，请重试' };
        }
        const dir = path.join(ensureTempDir(), 'voice-clone');
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, `rec-${Date.now()}.webm`);
        fs.writeFileSync(
          dest,
          buffer instanceof Uint8Array ? buffer : Buffer.from(buffer),
        );
        return { success: true, data: dest };
      } catch (error) {
        logMessage(`voiceClone saveRecording failed: ${error}`, 'error');
        return fail(error);
      }
    },
  );

  // 分析素材：16k 副本 + VAD 语音段 + 帧分析 + 推荐选段（会话驻留 main）。
  ipcMain.handle(
    'voiceClone:analyze',
    async (
      _event,
      { sourcePath, engine }: { sourcePath: string; engine: VoiceCloneEngine },
    ): Promise<VoiceCloneResponse> => {
      try {
        if (!sourcePath || !fs.existsSync(sourcePath)) {
          return { success: false, error: '素材文件不存在' };
        }
        const session = await analyzeCloneSource(sourcePath, engine, {
          tempDir: path.join(ensureTempDir(), 'voice-clone'),
        });
        return {
          success: true,
          data: { analysisId: session.id, ...analysisView(session) },
        };
      } catch (error) {
        logMessage(`voiceClone analyze failed: ${error}`, 'error');
        return fail(error);
      }
    },
  );

  // 选区质检（纯内存，选区拖动时防抖调用）。
  ipcMain.handle(
    'voiceClone:inspectRange',
    async (
      _event,
      {
        analysisId,
        startMs,
        endMs,
        engine,
      }: {
        analysisId: string;
        startMs: number;
        endMs: number;
        engine: VoiceCloneEngine;
      },
    ): Promise<VoiceCloneResponse> => {
      const session = getCloneAnalysisSession(analysisId);
      if (!session) {
        return { success: false, error: '分析会话已失效，请重新选择素材' };
      }
      try {
        const report = inspectCloneRange(
          session,
          startMs,
          endMs,
          CLONE_TARGET_RANGES[engine],
        );
        return { success: true, data: { report } };
      } catch (error) {
        return fail(error);
      }
    },
  );

  // 选区降噪试听（Step2 即时反馈：切选区 → gtcrn → 临时 wav 供 media:// 播放）。
  ipcMain.handle(
    'voiceClone:denoisePreview',
    async (
      _event,
      {
        analysisId,
        startMs,
        endMs,
      }: { analysisId: string; startMs: number; endMs: number },
    ): Promise<VoiceCloneResponse> => {
      const session = getCloneAnalysisSession(analysisId);
      if (!session) {
        return { success: false, error: '分析会话已失效，请重新选择素材' };
      }
      try {
        const r = await denoiseRangePreview(session, startMs, endMs);
        return { success: true, data: r };
      } catch (error) {
        logMessage(`voiceClone denoise preview failed: ${error}`, 'warning');
        return fail(error);
      }
    },
  );

  // 选区参考文本自动转写（本地 ASR → 云 ASR → 不可用降级手动）。
  ipcMain.handle(
    'voiceClone:transcribeRange',
    async (
      _event,
      {
        analysisId,
        startMs,
        endMs,
        language,
      }: {
        analysisId: string;
        startMs: number;
        endMs: number;
        language: 'zh' | 'en';
      },
    ): Promise<VoiceCloneResponse> => {
      const session = getCloneAnalysisSession(analysisId);
      if (!session) {
        return { success: false, error: '分析会话已失效，请重新选择素材' };
      }
      try {
        const r = await transcribeReferenceRange(
          session.analysisWavPath,
          startMs,
          endMs,
          language,
        );
        return { success: true, data: r };
      } catch (error) {
        logMessage(`voiceClone transcribe failed: ${error}`, 'warning');
        return fail(error);
      }
    },
  );

  // 字幕行清单（「从最近任务」来源的按行选段）。
  ipcMain.handle(
    'voiceClone:subtitleCues',
    async (
      _event,
      { subtitlePath }: { subtitlePath: string },
    ): Promise<VoiceCloneResponse> => {
      try {
        if (!subtitlePath || !fs.existsSync(subtitlePath)) {
          return { success: false, error: '字幕文件不存在' };
        }
        const content = fs.readFileSync(subtitlePath, 'utf-8');
        const cues = parseSubtitleCues(
          content,
          detectSubtitleFormat(subtitlePath),
        ).map((c) => ({
          startMs: c.startMs,
          endMs: c.endMs,
          text: c.text.replace(/\n+/g, ' ').trim(),
        }));
        return { success: true, data: cues };
      } catch (error) {
        return fail(error);
      }
    },
  );

  // 按选区时间窗取字幕文本（「从最近任务」来源的参考文本预填）。
  ipcMain.handle(
    'voiceClone:subtitleTextForRange',
    async (
      _event,
      {
        subtitlePath,
        startMs,
        endMs,
      }: { subtitlePath: string; startMs: number; endMs: number },
    ): Promise<VoiceCloneResponse> => {
      try {
        if (!subtitlePath || !fs.existsSync(subtitlePath)) {
          return { success: false, error: '字幕文件不存在' };
        }
        const content = fs.readFileSync(subtitlePath, 'utf-8');
        const cues = parseSubtitleCues(
          content,
          detectSubtitleFormat(subtitlePath),
        );
        const text = cues
          .filter((c) => c.endMs > startMs && c.startMs < endMs)
          .map((c) => c.text.replace(/\n+/g, ' ').trim())
          .filter(Boolean)
          .join(' ');
        return { success: true, data: text };
      } catch (error) {
        return fail(error);
      }
    },
  );

  // 创建克隆音色：定稿参考音频 → （火山：上传训练 + 轮询）→ 落库 →
  // 合成试听样本（失败不阻断创建）。
  ipcMain.handle(
    'voiceClone:create',
    async (
      _event,
      {
        analysisId,
        startMs,
        endMs,
        engine,
        language,
        name,
        refText,
        localDenoise,
        volc,
        eleven,
      }: {
        analysisId: string;
        startMs: number;
        endMs: number;
        engine: VoiceCloneEngine;
        language: 'zh' | 'en';
        name: string;
        refText: string;
        /** zipvoice：本地降噪（gtcrn；损相似度，噪音黄牌素材建议开）。 */
        localDenoise?: boolean;
        /** 火山分支参数（engine='volcengine' 时必传）。 */
        volc?: {
          providerId: string;
          speakerId: string;
          denoise?: boolean;
          mss?: boolean;
        };
        /** ElevenLabs 分支参数（engine='elevenlabs' 时必传）。 */
        eleven?: {
          providerId: string;
          /** 服务端去背景音（remove_background_noise）。 */
          removeNoise?: boolean;
        };
      },
    ): Promise<VoiceCloneResponse> => {
      const session = getCloneAnalysisSession(analysisId);
      if (!session) {
        return { success: false, error: '分析会话已失效，请重新选择素材' };
      }
      if (engine === 'zipvoice' && !refText?.trim()) {
        return { success: false, error: '请填写参考文本（与录音内容一致）' };
      }
      if (engine === 'volcengine') {
        if (!volc?.speakerId?.trim().startsWith('S_')) {
          return {
            success: false,
            error: '请填写有效的音色槽位 ID（S_ 开头，控制台购买后可见）',
          };
        }
      }
      let dir: string | null = null;
      try {
        // 云端凭据前置校验（失败不产生任何落盘）。
        const volcProvider =
          engine === 'volcengine'
            ? requireVolcCloneProvider(volc!.providerId)
            : null;
        const elevenProvider =
          engine === 'elevenlabs'
            ? requireElevenCloneProvider(eleven?.providerId)
            : null;

        const target = CLONE_TARGET_RANGES[engine];
        const id = newClonedVoiceId();
        dir = getClonedVoiceDir(id);
        const { refWavPath, report } = await prepareCloneReference(
          session,
          startMs,
          endMs,
          target,
          path.join(dir, 'ref.wav'),
          // 本地降噪仅 zipvoice 消费（火山有服务端降噪开关）。
          { denoise: engine === 'zipvoice' && !!localDenoise },
        );
        if (report.issues.some((i) => i.severity === 'error')) {
          fs.rmSync(dir, { recursive: true, force: true });
          return {
            success: false,
            error: '选区内没有足够的清晰语音，请调整选区',
          };
        }

        const voice: ClonedVoice = {
          id,
          name: name?.trim() || `我的音色 ${getClonedVoices().length + 1}`,
          engine,
          // zipvoice：参考文本即参考音频的转写，语言以其为准（跨语言
          // speed 补偿依赖该字段，比用户下拉更可靠）；火山沿用显式选择。
          language:
            engine === 'zipvoice' && refText?.trim()
              ? dominantTextLanguage(refText)
              : language,
          refWavPath,
          refText: refText?.trim() || undefined,
          quality: report,
          sourceFile: session.sourcePath,
          createdAt: Date.now(),
        };

        if (engine === 'volcengine' && volcProvider) {
          // 上传训练：失败即整体失败（不留半成品记录）；轮询超窗以 training 入库。
          const speakerId = volc!.speakerId.trim();
          voice.speakerId = speakerId;
          voice.providerId = String(volcProvider.id);
          await trainVolcCloneVoice(volcProvider, {
            speakerId,
            refWavPath,
            language,
            options: { denoise: volc?.denoise, mss: volc?.mss },
          });
          const { state, trainingTimesLeft } = await pollVolcTraining(
            volcProvider,
            speakerId,
          );
          voice.trainStatus = state === 'failed' ? 'failed' : state;
          if (trainingTimesLeft != null) {
            voice.volcTrainingTimesLeft = trainingTimesLeft;
          }
          if (state === 'failed') {
            voice.trainError = '服务端训练失败，请更换素材或开启降噪后重试';
          }
        }

        if (engine === 'elevenlabs' && elevenProvider) {
          // IVC 即时创建：上传即返 voice_id，无训练轮询。
          voice.speakerId = await addElevenVoice(elevenProvider, {
            name: voice.name,
            refWavPath,
            removeNoise: eleven?.removeNoise,
          });
          voice.providerId = String(elevenProvider.id);
          voice.trainStatus = 'ready';
        }

        saveClonedVoice(voice);

        // 试听样本 best-effort：模型未装/训练中/合成失败不阻断创建（面板可重试）。
        if (engine === 'zipvoice' || voice.trainStatus === 'ready') {
          try {
            voice.sampleWavPath = await synthesizeSampleFor(voice);
            saveClonedVoice(voice);
          } catch (e) {
            logMessage(`voiceClone sample synth failed: ${e}`, 'warning');
          }
        }
        return { success: true, data: voice };
      } catch (error) {
        if (dir) {
          try {
            fs.rmSync(dir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
        logMessage(`voiceClone create failed: ${error}`, 'error');
        return fail(error);
      }
    },
  );

  // 火山训练状态手动刷新（训练中的音色；就绪时顺手补试听样本）。
  ipcMain.handle(
    'voiceClone:volcRefreshStatus',
    async (_event, { id }: { id: string }): Promise<VoiceCloneResponse> => {
      const voice = getClonedVoiceById(id);
      if (!voice || voice.engine !== 'volcengine' || !voice.speakerId) {
        return { success: false, error: '克隆音色不存在' };
      }
      try {
        const provider = requireVolcCloneProvider(voice.providerId);
        const { state, trainingTimesLeft } = await queryVolcCloneStatus(
          provider,
          voice.speakerId,
        );
        const updated: ClonedVoice = {
          ...voice,
          trainStatus: state,
          ...(trainingTimesLeft != null
            ? { volcTrainingTimesLeft: trainingTimesLeft }
            : {}),
          trainError:
            state === 'failed'
              ? '服务端训练失败，请更换素材或开启降噪后重试'
              : undefined,
        };
        if (state === 'ready' && !updated.sampleWavPath) {
          try {
            updated.sampleWavPath = await synthesizeSampleFor(updated);
          } catch (e) {
            logMessage(`voiceClone sample synth failed: ${e}`, 'warning');
          }
        }
        saveClonedVoice(updated);
        return { success: true, data: updated };
      } catch (error) {
        return fail(error);
      }
    },
  );

  // 火山训练失败后的重新上传（复用已定稿的参考音频重训同一槽位）。
  ipcMain.handle(
    'voiceClone:volcRetrain',
    async (
      _event,
      { id, denoise, mss }: { id: string; denoise?: boolean; mss?: boolean },
    ): Promise<VoiceCloneResponse> => {
      const voice = getClonedVoiceById(id);
      if (
        !voice ||
        voice.engine !== 'volcengine' ||
        !voice.speakerId ||
        !voice.refWavPath ||
        !fs.existsSync(voice.refWavPath)
      ) {
        return { success: false, error: '克隆音色不存在或参考音频缺失' };
      }
      try {
        const provider = requireVolcCloneProvider(voice.providerId);
        await trainVolcCloneVoice(provider, {
          speakerId: voice.speakerId,
          refWavPath: voice.refWavPath,
          language: voice.language,
          options: { denoise, mss },
        });
        const { state, trainingTimesLeft } = await pollVolcTraining(
          provider,
          voice.speakerId,
        );
        const updated: ClonedVoice = {
          ...voice,
          trainStatus: state === 'failed' ? 'failed' : state,
          ...(trainingTimesLeft != null
            ? { volcTrainingTimesLeft: trainingTimesLeft }
            : {}),
          trainError:
            state === 'failed'
              ? '服务端训练失败，请更换素材或开启降噪后重试'
              : undefined,
        };
        if (state === 'ready' && !updated.sampleWavPath) {
          try {
            updated.sampleWavPath = await synthesizeSampleFor(updated);
          } catch (e) {
            logMessage(`voiceClone sample synth failed: ${e}`, 'warning');
          }
        }
        saveClonedVoice(updated);
        return { success: true, data: updated };
      } catch (error) {
        return fail(error);
      }
    },
  );

  // 音色清单。
  ipcMain.handle('voiceClone:list', async (): Promise<VoiceCloneResponse> => {
    return { success: true, data: getClonedVoices() };
  });

  // 重命名。
  ipcMain.handle(
    'voiceClone:rename',
    async (
      _event,
      { id, name }: { id: string; name: string },
    ): Promise<VoiceCloneResponse> => {
      try {
        return { success: true, data: renameClonedVoice(id, name) };
      } catch (error) {
        return fail(error);
      }
    },
  );

  // 删除（store 记录 + 音色目录）。
  ipcMain.handle(
    'voiceClone:remove',
    async (_event, { id }: { id: string }): Promise<VoiceCloneResponse> => {
      try {
        const voice = getClonedVoiceById(id);
        // EL 云端音色 best-effort 同步删除（失败不阻断本地删除，占用槽位可去官网清理）。
        if (voice?.engine === 'elevenlabs' && voice.speakerId) {
          const provider = getTtsProviderById(voice.providerId);
          if (provider?.type === TTS_ELEVENLABS) {
            await deleteElevenVoice(provider, voice.speakerId);
          }
        }
        removeClonedVoice(id);
        return { success: true, data: true };
      } catch (error) {
        return fail(error);
      }
    },
  );

  // 重新生成试听样本（面板动作；创建期样本失败的重试入口）。
  ipcMain.handle(
    'voiceClone:regenerateSample',
    async (_event, { id }: { id: string }): Promise<VoiceCloneResponse> => {
      const voice = getClonedVoiceById(id);
      if (!voice) return { success: false, error: '克隆音色不存在' };
      try {
        const updated = {
          ...voice,
          sampleWavPath: undefined as string | undefined,
        };
        updated.sampleWavPath = await synthesizeSampleFor(voice);
        saveClonedVoice(updated);
        return { success: true, data: updated };
      } catch (error) {
        return fail(error);
      }
    },
  );

  // 释放分析会话（向导关闭/换素材）。
  ipcMain.handle(
    'voiceClone:disposeAnalysis',
    async (
      _event,
      { analysisId }: { analysisId: string },
    ): Promise<VoiceCloneResponse> => {
      disposeCloneAnalysisSession(analysisId);
      return { success: true, data: true };
    },
  );

  // 导出音色（.svoice 单文件：元信息 + 参考文本 + wav base64）。
  ipcMain.handle(
    'voiceClone:export',
    async (_event, { id }: { id: string }): Promise<VoiceCloneResponse> => {
      const voice = getClonedVoiceById(id);
      if (!voice) return { success: false, error: '克隆音色不存在' };
      try {
        const result = await dialog.showSaveDialog(mainWindow, {
          defaultPath: `${voice.name}.${SVOICE_EXT}`,
          filters: [{ name: 'SmartSub Voice', extensions: [SVOICE_EXT] }],
        });
        if (result.canceled || !result.filePath) {
          return { success: false, cancelled: true };
        }
        const readB64 = (p?: string) =>
          p && fs.existsSync(p)
            ? fs.readFileSync(p).toString('base64')
            : undefined;
        const pkg = buildSvoicePackage(
          voice,
          readB64(voice.refWavPath),
          readB64(voice.sampleWavPath),
        );
        fs.writeFileSync(result.filePath, JSON.stringify(pkg));
        return { success: true, data: result.filePath };
      } catch (error) {
        logMessage(`voiceClone export failed: ${error}`, 'error');
        return fail(error);
      }
    },
  );

  // 导入音色（生成新 id，不覆盖既有；火山音色重绑本机豆包实例）。
  ipcMain.handle('voiceClone:import', async (): Promise<VoiceCloneResponse> => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'SmartSub Voice', extensions: [SVOICE_EXT] }],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, cancelled: true };
    }
    let dir: string | null = null;
    try {
      let payload: unknown;
      try {
        payload = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf-8'));
      } catch {
        return {
          success: false,
          error: '文件不是有效的音色包（JSON 解析失败）',
        };
      }
      const parsed = parseSvoicePackage(payload);
      if (!parsed.ok || !parsed.pkg) {
        return {
          success: false,
          error: `音色包校验失败（${parsed.error ?? 'unknown'}）`,
        };
      }
      const pkg = parsed.pkg;
      const id = newClonedVoiceId();
      dir = getClonedVoiceDir(id);
      const voice: ClonedVoice = {
        id,
        name: pkg.voice.name,
        engine: pkg.voice.engine,
        language: pkg.voice.language,
        refText: pkg.voice.refText,
        quality: pkg.voice.quality,
        createdAt: Date.now(),
      };
      if (pkg.refWavBase64) {
        voice.refWavPath = path.join(dir, 'ref.wav');
        fs.writeFileSync(
          voice.refWavPath,
          Buffer.from(pkg.refWavBase64, 'base64'),
        );
      }
      if (pkg.sampleWavBase64) {
        voice.sampleWavPath = path.join(dir, 'sample.wav');
        fs.writeFileSync(
          voice.sampleWavPath,
          Buffer.from(pkg.sampleWavBase64, 'base64'),
        );
      }
      if (pkg.voice.engine !== 'zipvoice') {
        voice.speakerId = pkg.voice.speakerId;
        // 云端音色属账号资产：重绑本机已配置的同品牌实例（品牌单例），状态按
        // 就绪（导出前提是已训练/已创建），刷新可校正。
        const brandType =
          pkg.voice.engine === 'volcengine' ? TTS_VOLCENGINE : TTS_ELEVENLABS;
        const brandProvider = getTtsProviders().find(
          (p) => p.type === brandType,
        );
        voice.providerId = brandProvider ? String(brandProvider.id) : undefined;
        voice.trainStatus = 'ready';
      }
      saveClonedVoice(voice);
      return { success: true, data: voice };
    } catch (error) {
      if (dir) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      logMessage(`voiceClone import failed: ${error}`, 'error');
      return fail(error);
    }
  });

  logMessage('声音克隆 IPC 处理函数已注册', 'info');
}
