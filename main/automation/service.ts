import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { createHash, randomUUID } from 'crypto';
import {
  operations,
  operationMap,
  type OperationDefinition,
} from '../../automation/catalog';
import { redact, redactDiagnostics } from '../../automation/redact';
import type { AutomationContext, AutomationJob } from '../../types/automation';
import { isPipelineWorkItem } from '../../types/workItem';
import { store } from '../helpers/store';
import {
  getWorkItems,
  getWorkItemById,
  deleteWorkItem,
} from '../helpers/workItemStore';
import {
  enqueueTaskSubmission,
  isTranscriptionBusy,
  isTaskProjectBusy,
  getTaskProjectSignal,
} from '../helpers/taskProcessor';
import { wrapFileObject } from '../helpers/fileUtils';
import { isProviderConfigured, PROVIDER_TYPES } from '../../types/provider';
import {
  isAsrProviderConfigured,
  ASR_PROVIDER_TYPES,
} from '../../types/asrProvider';
import { getEngineAdapter } from '../helpers/engines/registry';
import {
  parseSubtitleCues,
  serializeSubtitleCues,
  detectSubtitleFormatFromContent,
} from '../helpers/subtitleFormats';
import { dubbingSessionOwnership } from '../helpers/dubbing/sessionOwnership';
import {
  readConfigDraft,
  readCueDraft,
} from '../helpers/dubbing/configDraftStore';
import {
  getDubbingSession,
  restoreDubbingSession,
  previewVoice,
} from '../helpers/dubbing/dubbingProcessor';
import { TTS_MODELS, getInstalledTtsModels } from '../helpers/ttsModelCatalog';
import { parseTtsVoices, TTS_PROVIDER_TYPES } from '../../types/ttsProvider';
import { validateDownloadDependencies } from '../helpers/videoDownload/pipelineReadiness';
import { atomicReplaceTextFile } from '../helpers/atomicFile';
import { isModelDownloadBusy } from '../helpers/systemInfoManager';
import {
  DEFAULT_PIPELINE_STYLE,
  platformDefaultFont,
} from '../helpers/pipeline/deriveComposeConfig';
import { invokeHandler, sendHandler } from './handlers';
import { createServiceEvent } from './events';
import { JobStore, JobFailure, collectArtifacts, terminal } from './jobs';
import { getCt2ProgressKey } from '../helpers/fasterWhisperModelDownloader';
import { getFunasrProgressKey } from '../helpers/funasrModelDownloader';
import { getQwenProgressKey } from '../helpers/qwenModelDownloader';
import { getFireRedProgressKey } from '../helpers/fireRedModelDownloader';
import { getParakeetProgressKey } from '../helpers/parakeetModelDownloader';
import { getTtsProgressKey } from '../helpers/ttsModelDownloader';
import { SPEAKER_DIARIZATION_PROGRESS_KEY } from '../helpers/speakerDiarization/modelCatalog';

export function unwrap(value: any) {
  if (
    value?.success === false ||
    value?.ok === false ||
    (value?.error && value.success !== true)
  )
    throw new Error(
      typeof value.error === 'string'
        ? value.error
        : JSON.stringify(value.error || value),
    );
  return value;
}
export function contentVersion(file: string) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function assertInput(file: string) {
  if (!path.isAbsolute(file))
    throw new Error(`ABSOLUTE_PATH_REQUIRED: ${file}`);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile())
    throw new Error(`INPUT_UNAVAILABLE: ${file}`);
}
function assertOutput(file?: string) {
  if (!file) return;
  if (!path.isAbsolute(file)) throw new Error('ABSOLUTE_PATH_REQUIRED');
  if (fs.existsSync(file)) throw new Error(`OUTPUT_EXISTS: ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
}
function assertNoDraft(file: string) {
  const directory = path.join(app.getPath('userData'), 'proofread-drafts');
  if (!fs.existsSync(directory)) return;
  for (const name of fs
    .readdirSync(directory)
    .filter((n) => n.endsWith('.json'))) {
    const raw = fs.readFileSync(path.join(directory, name), 'utf8');
    if (raw.trim() === 'null') continue;
    const keyFile = path.join(directory, `${name}.key`);
    const key = fs.existsSync(keyFile)
      ? fs.readFileSync(keyFile, 'utf8')
      : undefined;
    // Old drafts lack identity metadata: retain their edits conservatively.
    if (!key || key.includes(JSON.stringify(file).slice(1, -1)))
      throw new Error('UNSAVED_EDITS: Save or discard the desktop draft first');
  }
}
const providerChannels = {
  translation: [
    'getTranslationProviders',
    'setTranslationProviders',
    'testTranslation',
  ],
  asr: ['getAsrProviders', 'setAsrProviders', 'testAsrProvider'],
  tts: ['getTtsProviders', 'setTtsProviders', 'testTtsProvider'],
};
const modelSuffix = {
  builtin: 'Model',
  fasterWhisper: 'Ct2Model',
  funasr: 'FunasrModel',
  qwen: 'QwenModel',
  fireRedAsr: 'FireRedModel',
  parakeet: 'ParakeetModel',
  tts: 'TtsModel',
  speakerDiarization: 'SpeakerDiarizationModel',
};

export class AutomationService {
  readonly jobs = new JobStore();
  private modelOperation = false;
  private editing = new Set<string>();
  private refreshReview(job: AutomationJob) {
    if (job.status !== 'review' || !job.projectId || this.jobs.isActive(job.id))
      return;
    const item = getWorkItemById(job.projectId);
    if (
      !item ||
      (item.status === 'review' && !isTaskProjectBusy(job.projectId))
    )
      return;
    this.jobs.resume(job.id, (ctx) => {
      ctx.setCancel(() => sendHandler('cancelTask', ctx.event, job.projectId));
      return this.waitProject(job.projectId!, ctx);
    });
  }
  private task(id: string) {
    const job = this.jobs.get(id);
    if (job) {
      this.refreshReview(job);
      return job;
    }
    const item = getWorkItemById(id);
    if (!item) throw new Error('TASK_NOT_FOUND');
    const { configSnapshot, ...result } = item;
    return {
      id,
      operation: item.type,
      status:
        (
          { waiting: 'queued', done: 'completed', error: 'failed' } as Record<
            string,
            string
          >
        )[item.status] || item.status,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      progress: item.pipelineFiles || item.downloadEntries,
      artifacts: item.artifacts || collectArtifacts(result),
      result,
      actions: ['running', 'waiting'].includes(item.status)
        ? isPipelineWorkItem(item)
          ? ['cancel', 'pause', 'resume']
          : ['download', 'compose'].includes(item.type)
            ? ['cancel']
            : []
        : isPipelineWorkItem(item) &&
            ['error', 'interrupted'].includes(item.status)
          ? ['retry']
          : [],
    };
  }
  async call(name: string, input: unknown) {
    const op = operationMap.get(name);
    if (!op) throw new Error('UNKNOWN_OPERATION');
    const args = op.schema.parse(input || {});
    if (op.long)
      return this.jobs.submit(name, args, (ctx) => this.execute(op, args, ctx));
    const event = createServiceEvent();
    try {
      return redact(
        await this.execute(op, args, {
          event,
          signal: new AbortController().signal,
          setCancel: () => {},
        }),
      );
    } finally {
      event.sender.emit('destroyed');
    }
  }
  private async invoke(
    channel: string,
    ctx: AutomationContext,
    ...args: any[]
  ) {
    return unwrap(await invokeHandler(channel, ctx.event, ...args));
  }
  private async providerList(
    kind: string,
    ctx: AutomationContext,
  ): Promise<any[]> {
    return this.invoke(providerChannels[kind][0], ctx);
  }
  private async pipeline(op: string, a: any, ctx: AutomationContext) {
    const form = {
      ...(store.get('userConfig') || {}),
      ...a.config,
      taskType:
        op === 'transcribe'
          ? 'generateOnly'
          : op === 'translate'
            ? 'translateOnly'
            : a.taskType,
      gates: a.config?.gates || { subtitle: 'auto', dubbing: 'auto' },
      sourceSrtSaveOption: 'fileNameWithLang',
      targetSrtSaveOption: 'fileNameWithLang',
    } as any;
    for (const [key, target] of [
      ['engine', 'transcriptionEngine'],
      ['model', 'model'],
      ['sourceLanguage', 'sourceLanguage'],
      ['targetLanguage', 'targetLanguage'],
    ])
      if (a[key] !== undefined) form[target] = a[key];
    if (a.providerId)
      form[
        form.transcriptionEngine === 'cloud' && op === 'transcribe'
          ? 'asrProviderId'
          : 'translateProvider'
      ] = a.providerId;
    for (const file of a.files) assertInput(file);
    if (
      form.taskType !== 'translateOnly' &&
      a.files.some((p: string) => !/\.(srt|vtt|ass|ssa|txt|lrc)$/i.test(p))
    ) {
      const adapter = getEngineAdapter(form.transcriptionEngine);
      if (!adapter) throw new Error('ENGINE_UNAVAILABLE: use engines.list');
      if (form.transcriptionEngine === 'cloud') {
        const provider = (await this.providerList('asr', ctx)).find(
          (p) => p.id === form.asrProviderId,
        );
        if (!isAsrProviderConfigured(provider))
          throw new Error('ASR_PROVIDER_REQUIRED');
      } else {
        const info = await this.invoke('getSystemInfo', ctx);
        const keys = {
          builtin: 'modelsInstalled',
          fasterWhisper: 'fasterWhisperModelsInstalled',
          funasr: 'funasrAsrModelsInstalled',
          qwen: 'qwenModelsInstalled',
          fireRedAsr: 'fireRedModelsInstalled',
          parakeet: 'parakeetModelsInstalled',
        };
        const list = info[keys[form.transcriptionEngine]];
        if (list && !list.includes(form.model))
          throw new Error(
            `MODEL_UNAVAILABLE: ${form.model}; use models.list or models.install`,
          );
        const ready = await adapter.isAvailable();
        if (ready.state !== 'ready')
          throw new Error(
            `ENGINE_UNAVAILABLE: ${ready.message || ready.state}`,
          );
      }
    }
    if (form.taskType !== 'generateOnly' && form.translateProvider !== '-1') {
      const provider = (await this.providerList('translation', ctx)).find(
        (p) => p.id === form.translateProvider,
      );
      if (!isProviderConfigured(provider))
        throw new Error('TRANSLATION_PROVIDER_REQUIRED');
      if (!form.targetLanguage || form.targetLanguage === 'auto')
        throw new Error('TARGET_LANGUAGE_REQUIRED');
    }
    const outputDir =
      a.outputDir ||
      path.join(app.getPath('userData'), 'automation', 'outputs', ctx.jobId!);
    if (!path.isAbsolute(outputDir)) throw new Error('ABSOLUTE_PATH_REQUIRED');
    // A per-task child prevents overwriting desktop outputs and same-name batch inputs.
    const files = a.files.map((file: string, index: number) => {
      const directory = path.join(
        outputDir,
        `${index + 1}-${path.basename(file, path.extname(file))}`,
      );
      fs.mkdirSync(directory, { recursive: true });
      if (fs.readdirSync(directory).length)
        throw new Error(`OUTPUT_EXISTS: ${directory}`);
      return { ...wrapFileObject(file), uuid: randomUUID(), directory };
    });
    const projectId = ctx.jobId!;
    validateDownloadDependencies({
      projectId,
      requestId: a.requestId || projectId,
      formData: form,
      files: files.map((file: any) =>
        /\.(srt|vtt|ass|ssa|txt|lrc)$/i.test(file.filePath)
          ? { ...file, providedSubtitlePath: file.filePath }
          : file,
      ),
    });
    const job = this.jobs.get(projectId)!;
    job.projectId = projectId;
    this.jobs.save(job);
    ctx.setCancel(() => sendHandler('cancelTask', ctx.event, projectId));
    if (ctx.signal.aborted) throw new Error('TASK_CANCELLED');
    unwrap(
      enqueueTaskSubmission({
        projectId,
        requestId: a.requestId || projectId,
        files,
        formData: form,
        name: a.name,
      }),
    );
    return this.waitProject(projectId, ctx);
  }
  private async waitProject(projectId: string, ctx: AutomationContext) {
    const executionSignal = getTaskProjectSignal(projectId);
    while (isTaskProjectBusy(projectId)) {
      const item = getWorkItemById(projectId);
      const job = ctx.jobId && this.jobs.get(ctx.jobId);
      if (job) {
        job.progress = redact(
          item?.pipelineFiles?.map((f) => ({
            uuid: f.uuid,
            activity: f.taskActivity,
          })),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const item = getWorkItemById(projectId);
    if (!item) throw new Error('TASK_NOT_FOUND');
    const job = ctx.jobId && this.jobs.get(ctx.jobId);
    if (job)
      job.progress = item.pipelineFiles?.map((f) => ({
        uuid: f.uuid,
        activity: f.taskActivity,
      }));
    const cancelled =
      ctx.signal.aborted ||
      executionSignal?.aborted ||
      Boolean(
        item.pipelineFiles?.some(
          (file) => file.taskActivity?.status === 'cancelled',
        ),
      );
    if (item.status === 'error' && !cancelled)
      throw new Error(
        `PIPELINE_FAILED: ${JSON.stringify(item.pipelineFiles?.map((f) => Object.fromEntries(Object.entries(f).filter(([k, v]) => k.endsWith('Error') && v))))}`,
      );
    return {
      projectId,
      status: cancelled
        ? 'cancelled'
        : item.status === 'review'
          ? 'review'
          : 'completed',
      files: item.pipelineFiles,
      artifacts: collectArtifacts(item.pipelineFiles),
      cancelled,
    };
  }
  private async execute(
    op: OperationDefinition,
    a: any,
    ctx: AutomationContext,
  ): Promise<any> {
    const name = op.name;
    if (name === 'system.logs')
      return redactDiagnostics(await this.invoke(op.channel!, ctx, a));
    if (['transcribe', 'translate', 'pipeline.run'].includes(name))
      return this.pipeline(name, a, ctx);
    if (name === 'system.capabilities')
      return operations.map(({ schema, ...rest }) => rest);
    if (name === 'system.info')
      return {
        version: app.getVersion(),
        apiVersion: 1,
        platform: process.platform,
        arch: process.arch,
        profile: app.getPath('userData'),
        background:
          require('electron').BrowserWindow.getAllWindows().length === 0,
        ...(await this.invoke('getSystemInfo', ctx)),
      };
    if (name === 'models.list')
      return {
        ...(await this.invoke('getSystemInfo', ctx)),
        ttsModels: getInstalledTtsModels(),
        ttsCatalog: TTS_MODELS,
      };
    if (name === 'tasks.list')
      return {
        jobs: this.jobs
          .list()
          .slice(0, a.limit)
          .map((j) => this.task(j.id)),
        desktop: getWorkItems()
          .slice(0, a.limit)
          .map((item) => this.task(item.id)),
      };
    if (name === 'tasks.get') return this.task(a.id);
    if (name === 'tasks.wait') {
      const deadline = Date.now() + a.timeoutMs;
      while (true) {
        const task = this.task(a.id);
        if (
          terminal.has(task.status) ||
          task.status === 'review' ||
          Date.now() >= deadline
        )
          return task;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (name === 'tasks.cancel') {
      if (this.jobs.get(a.id)) return this.jobs.cancel(a.id);
      const item = getWorkItemById(a.id);
      if (!item) throw new Error('TASK_NOT_FOUND');
      if (!['running', 'waiting'].includes(item.status)) return this.task(a.id);
      if (item.type === 'download')
        await this.invoke('videoDownload:cancelBatch', ctx, {
          workItemId: a.id,
        });
      else if (item.type === 'compose')
        await this.invoke('subtitleMerge:cancelMerge', ctx, { jobId: a.id });
      else if (isPipelineWorkItem(item))
        await sendHandler('cancelTask', ctx.event, a.id);
      else throw new Error('CANCEL_UNSUPPORTED: Use the owning desktop editor');
      return { id: a.id, status: 'cancelling' };
    }
    if (name === 'tasks.pause' || name === 'tasks.resume') {
      const projectId = this.jobs.get(a.id)?.projectId || a.id;
      const item = getWorkItemById(projectId);
      if (!item || !isPipelineWorkItem(item))
        throw new Error('PAUSE_UNSUPPORTED');
      if (!isTaskProjectBusy(projectId)) throw new Error('TASK_NOT_RUNNING');
      await sendHandler(
        name.endsWith('pause') ? 'pauseTask' : 'resumeTask',
        ctx.event,
        projectId,
      );
      const job = this.jobs.get(a.id);
      if (job) {
        job.status = name.endsWith('pause') ? 'paused' : 'running';
        this.jobs.save(job);
      }
      return {
        id: a.id,
        status: name.endsWith('pause') ? 'paused' : 'running',
      };
    }
    if (name === 'tasks.retry') {
      const replay = this.jobs.replay(name, a);
      if (replay) return replay;
      const projectId = this.jobs.get(a.id)?.projectId || a.id;
      const item = getWorkItemById(projectId);
      if (!item?.pipelineFiles || !item.configSnapshot)
        throw new Error('RETRY_UNSUPPORTED');
      if (isTaskProjectBusy(projectId)) throw new Error('TASK_BUSY');
      const status = this.jobs.get(a.id)?.status || item.status;
      if (!['failed', 'error', 'interrupted', 'cancelled'].includes(status))
        throw new Error('RETRY_NOT_NEEDED');
      return this.jobs.submit(name, a, async (retryCtx) => {
        const job = this.jobs.get(retryCtx.jobId!)!;
        job.projectId = projectId;
        this.jobs.save(job);
        retryCtx.setCancel(() =>
          sendHandler('cancelTask', retryCtx.event, projectId),
        );
        unwrap(
          enqueueTaskSubmission({
            projectId,
            requestId: a.requestId || randomUUID(),
            files: item.pipelineFiles,
            formData: item.configSnapshot as any,
          }),
        );
        return this.waitProject(projectId, retryCtx);
      });
    }
    if (name === 'tasks.delete') {
      const projectId = this.jobs.get(a.id)?.projectId || a.id;
      if (isTaskProjectBusy(projectId)) throw new Error('TASK_BUSY');
      const job = this.jobs.get(a.id);
      if (job) {
        if (this.jobs.isActive(a.id) || job.status === 'review')
          throw new Error('TASK_BUSY');
        if (job.projectId && getWorkItemById(job.projectId))
          deleteWorkItem(job.projectId);
        return this.jobs.delete(a.id);
      }
      deleteWorkItem(a.id);
      return { deleted: true };
    }
    if (name === 'pipeline.release') {
      const result = await this.invoke(op.channel!, ctx, a);
      this.jobs
        .list()
        .filter((j) => j.projectId === a.projectId)
        .forEach((j) => this.refreshReview(j));
      return result;
    }
    if (name === 'settings.get')
      return {
        settings: store.get('settings'),
        defaults: store.get('userConfig'),
      };
    if (name === 'settings.update')
      return this.invoke('setSettings', ctx, {
        ...store.get('settings'),
        ...a.settings,
      });
    if (name === 'providers.list') {
      const kinds = a.kind ? [a.kind] : Object.keys(providerChannels);
      return Object.fromEntries(
        await Promise.all(
          kinds.map(async (k) => [k, await this.providerList(k, ctx)]),
        ),
      );
    }
    if (name === 'providers.types') {
      const types = {
        translation: PROVIDER_TYPES,
        asr: ASR_PROVIDER_TYPES,
        tts: TTS_PROVIDER_TYPES,
      };
      return a.kind ? { [a.kind]: types[a.kind] } : types;
    }
    if (
      name.startsWith('providers.') &&
      ['save', 'delete', 'test'].includes(name.split('.')[1])
    ) {
      const list = await this.providerList(a.kind, ctx);
      if (name === 'providers.test') {
        const provider = list.find((p) => p.id === a.id);
        if (!provider) throw new Error('PROVIDER_NOT_FOUND');
        return this.invoke(
          providerChannels[a.kind][2],
          ctx,
          a.kind === 'translation'
            ? { provider, sourceLanguage: 'en', targetLanguage: 'zh' }
            : provider,
        );
      }
      let next;
      if (name === 'providers.delete') next = list.filter((p) => p.id !== a.id);
      else {
        if (!a.provider.id) throw new Error('PROVIDER_ID_REQUIRED');
        const old = list.find((p) => p.id === a.provider.id);
        const provider = { ...old, ...a.provider };
        if (!provider.type) throw new Error('PROVIDER_TYPE_REQUIRED');
        next = old
          ? list.map((p) => (p.id === provider.id ? provider : p))
          : [...list, provider];
      }
      return this.invoke(providerChannels[a.kind][1], ctx, {
        providers: next,
        expectedProviders: list,
      });
    }
    if (name === 'models.install' || name === 'models.delete') {
      if (
        this.modelOperation ||
        isModelDownloadBusy() ||
        isTranscriptionBusy() ||
        this.jobs
          .list()
          .some(
            (j) =>
              j.id !== ctx.jobId &&
              !terminal.has(j.status) &&
              /tts|dubbing|pipeline|voices/.test(j.operation),
          )
      )
        throw new Error('ENGINE_BUSY');
      if (a.model && (!/^[\w./-]+$/.test(a.model) || a.model.includes('..')))
        throw new Error('INVALID_MODEL');
      if (a.engine !== 'speakerDiarization' && !a.model)
        throw new Error('MODEL_REQUIRED');
      if (a.engine !== 'fasterWhisper' && a.model?.includes('/'))
        throw new Error('INVALID_MODEL');
      const suffix = modelSuffix[a.engine];
      if (name === 'models.delete')
        return this.invoke(`delete${suffix}`, ctx, a.model);
      this.modelOperation = true;
      try {
        const key = {
          builtin: () => a.model.toLowerCase(),
          fasterWhisper: () => getCt2ProgressKey(a.model),
          funasr: () => getFunasrProgressKey(a.model),
          qwen: () => getQwenProgressKey(a.model),
          fireRedAsr: () => getFireRedProgressKey(a.model),
          parakeet: () => getParakeetProgressKey(a.model),
          tts: () => getTtsProgressKey(a.model),
          speakerDiarization: () => SPEAKER_DIARIZATION_PROGRESS_KEY,
        }[a.engine]();
        ctx.trackModelProgress?.(key);
        // All download handlers acquire their shared lock synchronously before
        // their first await. Cancellation is installed only after we own it.
        const pending = this.invoke(`download${suffix}`, ctx, {
          ...a,
          requestId: ctx.jobId,
        });
        ctx.setCancel(() => invokeHandler('cancelModelDownload', ctx.event));
        return await pending;
      } finally {
        this.modelOperation = false;
      }
    }
    if (name === 'subtitles.read') {
      assertInput(a.filePath);
      const raw = fs.readFileSync(a.filePath, 'utf8');
      const format = detectSubtitleFormatFromContent(a.filePath, raw);
      const cues = parseSubtitleCues(raw, format);
      return {
        filePath: a.filePath,
        version: contentVersion(a.filePath),
        format,
        total: cues.length,
        offset: a.offset,
        cues: cues.slice(a.offset, a.offset + a.limit),
      };
    }
    if (name === 'proofread.read')
      return {
        ...(await this.invoke(op.channel!, ctx, { ...a, strict: true })),
        version: contentVersion(a.filePath),
      };
    if (name === 'subtitles.write' || name === 'proofread.save') {
      if (!path.isAbsolute(a.filePath))
        throw new Error('ABSOLUTE_PATH_REQUIRED');
      const file = path.resolve(a.filePath);
      if (this.editing.has(file)) throw new Error('EDIT_CONFLICT');
      this.editing.add(file);
      try {
        const existed = fs.existsSync(file);
        if (existed) {
          if (name === 'subtitles.write' && !a.overwrite)
            throw new Error('OUTPUT_EXISTS');
          if (!a.expectedVersion || contentVersion(file) !== a.expectedVersion)
            throw new Error('EDIT_CONFLICT');
          assertNoDraft(file);
        } else if (name === 'proofread.save')
          throw new Error('INPUT_UNAVAILABLE');
        if (name === 'proofread.save')
          return await this.invoke('saveProofreadDataAndRender', ctx, {
            ...a,
            proofreadDataFile: file,
          });
        for (const cue of a.cues)
          if (cue.endMs < cue.startMs) throw new Error('INVALID_CUE_TIME');
        const format = a.format || path.extname(file).slice(1);
        if (!['srt', 'vtt', 'ass', 'lrc', 'txt'].includes(format))
          throw new Error('INVALID_SUBTITLE_FORMAT');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const text = serializeSubtitleCues(a.cues, format);
        if (existed)
          fs.copyFileSync(
            file,
            `${file}.${Date.now()}.bak`,
            fs.constants.COPYFILE_EXCL,
          );
        if (existed) await atomicReplaceTextFile(file, text);
        else {
          const temp = `${file}.${randomUUID()}.tmp`;
          try {
            await atomicReplaceTextFile(temp, text);
            // Linking a fully written sibling publishes atomically and never replaces a concurrent creation.
            fs.linkSync(temp, file);
          } finally {
            fs.rmSync(temp, { force: true });
          }
        }
        return { filePath: file, version: contentVersion(file) };
      } finally {
        this.editing.delete(file);
      }
    }
    if (name === 'tts.voices') {
      if (a.providerId) {
        const provider = (await this.providerList('tts', ctx)).find(
          (p) => p.id === a.providerId,
        );
        if (!provider) throw new Error('PROVIDER_NOT_FOUND');
        return ['azureSpeech', 'elevenlabs'].includes(provider.type)
          ? this.invoke('listTtsVoices', ctx, provider)
          : {
              voices: parseTtsVoices(provider).map((id) => ({ id, name: id })),
            };
      }
      return getInstalledTtsModels().map((id) => ({
        id,
        voices: TTS_MODELS[id].voices,
      }));
    }
    if (name === 'tts.synthesize') {
      if (Boolean(a.model) === Boolean(a.providerId))
        throw new Error('SELECT_EXACTLY_ONE_TTS_MODEL_OR_PROVIDER');
      const output =
        a.outputPath ||
        path.join(
          app.getPath('userData'),
          'automation',
          'outputs',
          ctx.jobId!,
          'speech.wav',
        );
      assertOutput(output);
      ctx.setCancel(() => {});
      const result = await previewVoice(
        a.model
          ? { kind: 'local', modelId: a.model }
          : { kind: 'cloud', providerId: a.providerId },
        a.voice,
        a.text,
        { signal: ctx.signal, language: a.language } as any,
      );
      fs.copyFileSync(result.wavPath, output, fs.constants.COPYFILE_EXCL);
      return { ...result, wavPath: output };
    }
    if (name === 'downloads.start') {
      const item = await this.invoke('videoDownload:start', ctx, a.config);
      ctx.setCancel(() =>
        invokeHandler('videoDownload:cancelBatch', ctx.event, {
          workItemId: item.id,
        }),
      );
      const job = this.jobs.get(ctx.jobId!)!;
      job.projectId = item.id;
      this.jobs.save(job);
      while (true) {
        const current = getWorkItemById(item.id);
        if (!current) throw new Error('TASK_NOT_FOUND');
        if (!['running', 'waiting'].includes(current.status)) {
          if (current.status === 'error')
            throw new Error(
              `DOWNLOAD_FAILED: ${JSON.stringify(current.downloadEntries)}`,
            );
          return current;
        }
        job.progress = redact(current.downloadEntries);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (!op.channel) throw new Error('OPERATION_UNAVAILABLE');
    let payload = { ...a.config, ...a };
    delete payload.config;
    if (name === 'subtitles.optimize' && a.mode === 'source')
      payload.mode = 'transcript';
    // These handlers expect the nested DubbingConfig rather than a flattened payload.
    if (name.startsWith('dubbing.')) payload = { ...a };
    if (a.outputPath) assertOutput(a.outputPath);
    if (a.config?.outputPath) assertOutput(a.config.outputPath);
    if (
      name.startsWith('media.') &&
      op.cancelChannel &&
      name !== 'media.extract-subtitles'
    )
      payload = {
        config: { ...a.config, videoPath: a.filePath },
        jobId: ctx.jobId,
      };
    if (name === 'subtitles.sync')
      payload = { mode: 'offset', ...a.config, ...a };
    if (name === 'subtitles.merge')
      payload = { primaryPosition: 'top', ...a.config, ...a };
    if (name === 'subtitles.split') payload = { ...a.config, ...a };
    if (name === 'compose.run')
      payload = {
        outputMode: 'hardcode',
        ...a.config,
        ...a,
        style: {
          ...DEFAULT_PIPELINE_STYLE,
          fontName: platformDefaultFont(process.platform),
          ...a.config?.style,
        },
        requestId: ctx.jobId,
      };
    if (name === 'compose.run') {
      let composeId: string | undefined;
      const cancel = async () => {
        if (composeId)
          await invokeHandler(op.cancelChannel!, ctx.event, {
            jobId: composeId,
          });
      };
      const queued = (data: any) => {
        if (data.requestId !== ctx.jobId) return;
        composeId = data.jobId;
        if (ctx.signal.aborted) void cancel();
      };
      ctx.event.sender.on('subtitleMerge:queued', queued);
      ctx.setCancel(cancel);
      try {
        return await this.invoke(op.channel, ctx, payload);
      } finally {
        ctx.event.sender.off('subtitleMerge:queued', queued);
      }
    }
    if (op.cancelChannel)
      ctx.setCancel(async () => {
        await invokeHandler(
          op.cancelChannel!,
          ctx.event,
          name.startsWith('dubbing.')
            ? payload
            : name === 'downloads.install'
              ? { engine: a.engine }
              : ctx.jobId,
        );
      });
    if (name === 'dubbing.create') {
      const leaseId = randomUUID();
      const result = await this.invoke(op.channel, ctx, { ...a, leaseId });
      if (result.data?.locked) throw new Error('SESSION_BUSY');
      if (result.data?.sessionId)
        dubbingSessionOwnership.release(
          result.data.sessionId,
          ctx.event.sender.id,
          leaseId,
        );
      return result;
    }
    if (name.startsWith('dubbing.') && name !== 'dubbing.get') {
      if (readConfigDraft(a.sessionId) || readCueDraft(a.sessionId))
        throw new Error('UNSAVED_EDITS');
      const leaseId = randomUUID();
      if (
        !dubbingSessionOwnership.acquire(
          a.sessionId,
          ctx.event.sender.id,
          leaseId,
        )
      )
        throw new Error('SESSION_BUSY');
      try {
        if (op.cancelChannel)
          ctx.setCancel(() =>
            invokeHandler(op.cancelChannel!, ctx.event, {
              ...payload,
              leaseId,
            }),
          );
        if (!getDubbingSession(a.sessionId)) {
          const result = restoreDubbingSession(a.sessionId);
          if (result.kind !== 'ok') throw new Error(`SESSION_${result.kind}`);
        }
        const session = getDubbingSession(a.sessionId)!;
        const loaded = await this.invoke('dubbing:loadSubtitle', ctx, {
          sessionId: a.sessionId,
          subtitlePath: session.subtitlePath,
          leaseId,
        });
        if (loaded.data?.locked) throw new Error('SESSION_BUSY');
        const result = await this.invoke(op.channel, ctx, {
          ...payload,
          leaseId,
          requestId: ctx.jobId,
        });
        if (name === 'dubbing.run') {
          if (result.cancelled || result.data?.cancelled)
            return { ...result, cancelled: true };
          if (result.data?.failedIndexes?.length)
            throw new JobFailure(
              `DUBBING_CUES_FAILED: ${result.data.failedIndexes.length} cue(s) failed`,
              result,
            );
        }
        return result;
      } finally {
        dubbingSessionOwnership.release(
          a.sessionId,
          ctx.event.sender.id,
          leaseId,
        );
      }
    }
    if (name === 'glossaries.import')
      return this.invoke(op.channel, ctx, a.glossaryId, a.sourcePath);
    const result = await this.invoke(
      op.channel,
      ctx,
      op.argument ? a[op.argument] : payload,
      ...(name === 'media.extract-subtitles' ? [ctx.jobId] : []),
    );
    return result;
  }
}
