import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IFiles, IFormData } from '../../../types';
import type { StageOutcome } from '../../../types/taskRun';
import { resolveSubtitleOutputFormats } from '../../../types/subtitleOutput';
import { runWithTaskContext } from '../taskContext';
import {
  extractAudioFromVideo,
  probeEmbeddedSubtitles,
  extractEmbeddedSubtitle,
} from '../audioProcessor';
import {
  canHaveEmbeddedSubtitle,
  shouldUseEmbeddedSubtitles,
  srtHasCues,
} from '../embeddedSubtitleParser';
import { routeTranscription } from '../transcriptionRouter';
import { checkOpenAiWhisper, getPath } from '../whisper';
import { runSubtitleRefineStage } from '../subtitleRefineStage';
import { runManuscriptMatchingStage } from '../manuscriptMatchingStage';
import {
  getDesiredChineseScript,
  convertChineseText,
  removeChineseSubtitlePunctuation,
} from '../chineseConvert';
import { runEpisodeSummaryStage } from '../episodeSummary';
import translate from '../../translate';
import { store } from '../store';
import { createExtendedProvider } from '../extendedProvider';
import { resolveProviderFallbacks } from '../providerMigration';
import { runSpeakerDiarizationStage } from '../speakerDiarization/stage';
import { annotateCuesWithSpeakers } from '../speakerDiarization/alignment';
import {
  parseSubtitleCues,
  detectSubtitleFormatFromContent,
  serializeSubtitleCues,
} from '../subtitleFormats';
import {
  writeProofreadDataFromFiles,
  readProofreadDataFile,
  updateProofreadDataOutputs,
} from '../proofreadData';
import { writeSubtitleDeliverables } from '../subtitleDeliverables';
import { createComposeOutput } from '../compose/composeOutput';
import { runDubStage, rebuildDubTrackForFile } from '../pipeline/dubStage';
import { runComposeStage } from '../pipeline/composeStage';
import { notifyGateReview } from '../pipeline/gateManager';
import { getSrtFileName } from '../utils';
import { TaskActivityReporter } from '../taskActivity';
import { digestValue, stableJson } from './service';
import {
  createStageArtifactStore,
  copyIndependent,
  hashFile,
  type StageArtifactStore,
} from './artifacts';
import { getRunStore, getRunService } from './runtime';
import { decideStageReuse, stageFingerprint } from './cache';
import {
  getSessionDir,
  readSessionMeta,
  flushSessionMeta,
} from '../dubbing/sessionStore';
import type { StageExecutionContext, StageResult } from './execution';

const subtitleInput = (file: IFiles) =>
  /\.(srt|vtt|ass|ssa|lrc|txt)$/i.test(file.filePath);
const pathFields = [
  'srtFile',
  'tempSrtFile',
  'tempAudioFile',
  'translatedSrtFile',
  'tempTranslatedSrtFile',
  'tempFinalSubtitleFile',
  'wordTimelineFile',
  'speechReviewFile',
  'speechReviewOriginalFile',
  'speakerSegmentsFile',
  'proofreadDataFile',
  'dubbedTrackPath',
  'shiftedSubtitlePath',
  'inputSubtitlePath',
  'providedSubtitlePath',
  'manuscriptPath',
];

async function writable(file: any, keys: string[], directory: string) {
  const copies = new Map<string, string>();
  for (const key of keys) {
    const source = file[key];
    if (!source || source === '__none__' || !fs.existsSync(source)) continue;
    const target =
      copies.get(source) ||
      path.join(directory, `${key}${path.extname(source)}`);
    if (!copies.has(source)) {
      await copyIndependent(source, target);
      copies.set(source, target);
    }
    file[key] = target;
  }
}
async function providers(config: Record<string, any>) {
  const all = store.get('translationProviders') || [];
  const primary = all.find((p) => p.id === config.translateProvider);
  return primary
    ? Promise.all(
        [primary, ...resolveProviderFallbacks(all, primary)].map(
          createExtendedProvider,
        ),
      )
    : [];
}
async function publish(
  source: string,
  desired: string,
  inputs: string[],
  signal?: AbortSignal,
) {
  const output = createComposeOutput(desired, inputs);
  try {
    await copyIndependent(source, output.staged);
    return await output.publish(signal || new AbortController().signal);
  } finally {
    output.cleanup();
  }
}
async function snapshotDubbing(file: any, workspace: string) {
  const meta = readSessionMeta(file.dubbingSessionId);
  if (!meta) throw new Error('TASK_DUBBING_METADATA_MISSING');
  const snapshot: any = { meta: structuredClone(meta), files: {} };
  for (const cue of meta.cues)
    if (cue.wavFile) {
      const target = path.join(
        workspace,
        'dubbing',
        path.basename(cue.wavFile),
      );
      await copyIndependent(
        path.join(getSessionDir(meta.sessionId), cue.wavFile),
        target,
      );
      snapshot.files[cue.wavFile] = target;
    }
  const subtitle = path.join(workspace, 'dubbing', 'input.srt');
  await copyIndependent(meta.subtitlePath, subtitle);
  snapshot.meta.subtitlePath = subtitle;
  delete snapshot.meta.proofreadDataFile;
  file.dubbingSnapshot = snapshot;
}
async function materializeReusedResult(
  file: any,
  ctx: StageExecutionContext,
  artifacts: StageArtifactStore,
) {
  if (
    ['prepareProofread', 'exportSubtitle'].includes(ctx.stage.id) &&
    file.proofreadDataFile
  ) {
    await materializeEditableProofread(file, ctx, artifacts);
  }
  if (ctx.stage.id === 'dubbing') {
    const snapshot = file.dubbingSnapshot;
    if (!snapshot?.meta) throw new Error('TASK_DUBBING_SNAPSHOT_MISSING');
    const sessionId = randomUUID();
    await fs.promises.mkdir(getSessionDir(sessionId), { recursive: true });
    for (const [name, source] of Object.entries(snapshot.files))
      await copyIndependent(
        source as string,
        path.join(getSessionDir(sessionId), path.basename(name)),
      );
    flushSessionMeta(
      {
        ...snapshot.meta,
        sessionId,
        proofreadDataFile: file.proofreadDataFile,
        updatedAt: Date.now(),
      },
      true,
    );
    file.dubbingSessionId = sessionId;
  }
  if (ctx.stage.id === 'exportSubtitle') {
    file.sourceSubtitleFiles = [];
    file.translatedSubtitleFiles = [];
    for (const delivery of file.internalDeliverables || []) {
      const target = await publish(
        delivery.source,
        delivery.desired,
        [file.filePath, file.providedSubtitlePath].filter(Boolean),
        ctx.signal,
      );
      file[
        delivery.role === 'source'
          ? 'sourceSubtitleFiles'
          : 'translatedSubtitleFiles'
      ].push(target);
      delivery.target = target;
    }
    file.srtFile = file.sourceSubtitleFiles[0] || file.tempSrtFile;
    file.translatedSrtFile =
      file.translatedSubtitleFiles[0] || file.tempFinalSubtitleFile;
    if (file.proofreadDataFile)
      await updateProofreadDataOutputs(file, ctx.signal);
  }
  if (ctx.stage.id === 'composeVideo' && file.internalFinalVideoPath)
    file.finalVideoPath = await publish(
      file.internalFinalVideoPath,
      file.finalVideoPath,
      [file.filePath],
      ctx.signal,
    );
  if (
    ctx.stage.id === 'dubbingTrack' &&
    !ctx.run.config.compose &&
    file.dubbedTrackPath
  )
    file.dubbedAudioPath = await publish(
      file.dubbedTrackPath,
      path.join(ctx.file.input.directory, `${file.fileName}-dubbed.wav`),
      [file.filePath],
      ctx.signal,
    );
}
async function materializeEditableProofread(
  file: any,
  ctx: StageExecutionContext,
  artifacts: StageArtifactStore,
) {
  const directory = path.join(
    artifacts.fileDirectory(ctx.run.projectId, ctx.run.runId, ctx.file.fileId),
    'edits',
  );
  const editable = path.join(directory, 'proofread.json');
  if (file.proofreadDataFile !== editable)
    await copyIndependent(file.proofreadDataFile, editable);
  file.proofreadDataFile = editable;
  const source = file.tempSrtFile || file.srtFile;
  const final = file.tempFinalSubtitleFile || file.translatedSrtFile;
  for (const [key, value, name] of [
    ['tempSrtFile', source, 'source.srt'],
    ['tempFinalSubtitleFile', final, 'final.srt'],
    ['tempTranslatedSrtFile', file.tempTranslatedSrtFile, 'target.srt'],
  ]) {
    if (!value) continue;
    const destination = path.join(directory, name);
    if (value !== destination) await copyIndependent(value, destination);
    file[key] = destination;
  }
  if (!file.sourceSubtitleFiles?.length) file.srtFile = file.tempSrtFile;
  if (!file.translatedSubtitleFiles?.length)
    file.translatedSrtFile = file.tempFinalSubtitleFile;
  const data = await readProofreadDataFile(editable);
  data.meta.targetFile = file.tempTranslatedSrtFile;
  await fs.promises.writeFile(editable, JSON.stringify(data));
  await updateProofreadDataOutputs(file, ctx.signal);
}
async function exportSubtitles(
  file: any,
  config: IFormData & Record<string, any>,
  ctx: StageExecutionContext,
  workspace: string,
) {
  const sourceOwned =
    !subtitleInput(ctx.file.input) && !ctx.file.input.providedSubtitlePath;
  const translationActive =
    config.taskType !== 'generateOnly' && config.translateProvider !== '-1';
  const canonicalSource = file.srtFile;
  const canonicalTarget = file.translatedSrtFile;
  await writable(file, ['srtFile', 'translatedSrtFile'], workspace);
  if (
    sourceOwned &&
    config.removeChinesePunctuation &&
    getDesiredChineseScript(config.sourceLanguage)
  ) {
    const source = await fs.promises.readFile(file.srtFile, 'utf8');
    await fs.promises.writeFile(
      file.srtFile,
      removeChineseSubtitlePunctuation(source),
    );
  }
  const requests: Parameters<typeof writeSubtitleDeliverables>[0] = [];
  const formats = resolveSubtitleOutputFormats(config);
  if (
    sourceOwned &&
    !(translationActive && config.sourceSrtSaveOption === 'noSave')
  )
    requests.push({ kind: 'source', srtPath: file.srtFile, formats });
  if (translationActive && file.translatedSrtFile)
    requests.push({ kind: 'target', srtPath: file.translatedSrtFile, formats });
  for (const request of requests)
    if (config.subtitleLayout === 'two-line') {
      request.layout = {
        subtitleLayout: config.subtitleLayout,
        subtitleLineWidth: config.subtitleLineWidth,
      };
      if (
        request.kind === 'target' &&
        config.translateContent !== 'onlyTranslate'
      ) {
        request.bilingual = (
          await readProofreadDataFile(file.proofreadDataFile)
        ).cues;
        request.contentType = config.translateContent;
      }
    }
  const outputs = await writeSubtitleDeliverables(
    requests,
    [file.filePath, file.providedSubtitlePath].filter(Boolean),
    ctx.signal,
  );
  file.sourceSubtitleFiles = [];
  file.translatedSubtitleFiles = [];
  file.internalDeliverables = [];
  for (const output of outputs) {
    const role = output.kind;
    const base = getSrtFileName(
      role === 'source'
        ? config.sourceSrtSaveOption
        : config.targetSrtSaveOption,
      file.fileName,
      role === 'source' ? config.sourceLanguage : config.targetLanguage,
      role === 'source'
        ? config.customSourceSrtFileName
        : config.customTargetSrtFileName,
      {
        fileName: file.fileName,
        sourceLanguage: config.sourceLanguage,
        targetLanguage: config.targetLanguage,
        model: config.model,
        translateProvider: '',
      },
    );
    for (const source of output.files) {
      const desired = path.join(
        ctx.file.input.directory,
        `${path.basename(base)}${path.extname(source)}`,
      );
      const target = await publish(
        source,
        desired,
        [file.filePath, file.providedSubtitlePath].filter(Boolean),
        ctx.signal,
      );
      file[
        role === 'source' ? 'sourceSubtitleFiles' : 'translatedSubtitleFiles'
      ].push(target);
      file.internalDeliverables.push({ source, desired, target, role });
    }
  }
  file.tempSrtFile = canonicalSource;
  file.tempFinalSubtitleFile = canonicalTarget;
  file.srtFile = file.sourceSubtitleFiles[0] || canonicalSource;
  file.translatedSrtFile = file.translatedSubtitleFiles[0] || canonicalTarget;
  if (file.proofreadDataFile)
    await updateProofreadDataOutputs(file, ctx.signal);
}

/** Adapts existing implementations without changing their resource locks or providers. */
export function createDesktopStageExecutor(sender: any) {
  const artifacts = createStageArtifactStore(getRunStore());
  return async (ctx: StageExecutionContext) =>
    runWithTaskContext(
      {
        projectId: ctx.run.projectId,
        runId: ctx.run.runId,
        fileUuid: ctx.file.fileId,
        attemptId: ctx.token.attemptId,
        resolvedConfig: ctx.run.resolvedConfig,
        signal: ctx.signal,
      },
      async () => {
        const workspace = artifacts.workspace(ctx.token);
        const file: any = {
          ...structuredClone(ctx.file.projection),
          taskRunId: ctx.run.runId,
          directory: workspace,
        };
        const config = structuredClone(ctx.run.config) as IFormData &
          Record<string, any>;
        const stageId = ctx.stage.id;
        let outcome: StageOutcome = 'executed';
        let reason: string | undefined;
        let inputDigest: string | undefined;
        let inputIdentity: StageResult['inputIdentity'];
        const event: any = {
          sender: {
            ...sender,
            send(channel: string, ...args: any[]) {
              if (channel === 'taskProgressChange') {
                ctx.progress(Math.min(99, args[2]));
                return;
              }
              if (channel === 'taskStatusChange') {
                file[args[1]] = args[2];
                return;
              }
              if (channel === 'taskErrorChange') {
                file[`${args[1]}Error`] = args[2];
                return;
              }
              if (channel === 'taskFileChange') {
                Object.assign(file, args[0]);
                if (
                  file.dubbingSessionId &&
                  file.dubbingSessionId !== ctx.file.projection.dubbingSessionId
                ) {
                  if (
                    !ctx.checkpoint({
                      ...file,
                      directory: ctx.file.input.directory,
                    })
                  )
                    throw new Error('TASK_ATTEMPT_STALE');
                }
                return;
              }
              if (channel === 'taskActivityChange') return;
              sender.send(channel, ...args);
            },
          },
        };
        // Detect media replacement between accepted preparation and every later stage.
        if (
          stageId !== 'prepareInput' &&
          ctx.file.inputIdentity &&
          !subtitleInput(ctx.file.input)
        ) {
          const now = await fs.promises.stat(ctx.file.input.filePath);
          for (const key of ['size', 'mtimeMs', 'ctimeMs', 'ino'] as const)
            if (now[key] !== ctx.file.inputIdentity[key])
              throw new Error('TASK_INPUT_CHANGED');
        }
        const decision = await decideStageReuse({
          run: ctx.run,
          file: ctx.file,
          stageId,
          previous: ctx.run.previousRunId
            ? getRunService().get(ctx.run.projectId, ctx.run.previousRunId)
            : null,
          artifacts,
          signal: ctx.signal,
          force: ctx.run.config.forceRerun === true,
        });
        if (decision.reusable) {
          const projection = {
            ...ctx.file.projection,
            ...structuredClone(decision.patch),
          };
          await materializeReusedResult(projection, ctx, artifacts);
          return {
            outcome: 'reused' as const,
            reason: decision.reason,
            fingerprint: decision.fingerprint,
            artifacts: decision.artifacts,
            reusedFrom: decision.reusedFrom,
            projection,
          };
        }
        const activity = new TaskActivityReporter(
          Date.now(),
          (state) => {
            file.taskActivity = state;
          },
          ctx.signal,
        );
        try {
          if (stageId === 'prepareInput') {
            const hashed = await hashFile(
              file.filePath,
              ctx.signal,
              ctx.progress,
            );
            inputIdentity = hashed.identity;
            const dependencies: Record<string, string> = {
              media: hashed.digest,
            };
            if (subtitleInput(file)) file.inputSubtitlePath = file.filePath;
            file.manuscriptPath ??= config.manuscriptPath;
            for (const key of [
              'inputSubtitlePath',
              'providedSubtitlePath',
              'manuscriptPath',
            ])
              if (file[key] && file[key] !== '__none__') {
                const source = file[key];
                const before = await hashFile(source, ctx.signal);
                await writable(file, [key], workspace);
                const copied = await hashFile(file[key], ctx.signal);
                if (before.digest !== copied.digest)
                  throw new Error('TASK_INPUT_CHANGED');
                dependencies[key] = copied.digest;
              }
            file.inputDigests = dependencies;
            inputDigest = digestValue(dependencies);
          } else if (stageId === 'extractAudio') {
            if (
              shouldUseEmbeddedSubtitles(config) &&
              canHaveEmbeddedSubtitle(file.fileExtension) &&
              !file.providedSubtitlePath
            ) {
              try {
                const track = (
                  await probeEmbeddedSubtitles(file.filePath)
                ).find((track) => track.isText);
                if (track) {
                  file.srtFile = path.join(workspace, 'embedded.srt');
                  await extractEmbeddedSubtitle(
                    file.filePath,
                    track.subIndex,
                    file.srtFile,
                    event,
                    file,
                  );
                  if (
                    !srtHasCues(
                      await fs.promises.readFile(file.srtFile, 'utf8'),
                    )
                  )
                    throw new Error('EMPTY_EMBEDDED_SUBTITLE');
                  file.embeddedSubtitle = true;
                }
              } catch (error) {
                ctx.signal?.throwIfAborted();
                file.embeddedSubtitle = false;
                file.srtFile = undefined;
              }
            }
            if (!file.embeddedSubtitle || config.speakerDiarization)
              await extractAudioFromVideo(event, file);
            else {
              outcome = 'not_applicable';
              reason = 'EMBEDDED_SUBTITLE';
            }
            if (config.saveAudio && file.tempAudioFile)
              file.audioFile = await publish(
                file.tempAudioFile,
                path.join(ctx.file.input.directory, `${file.fileName}.wav`),
                [file.filePath],
                ctx.signal,
              );
          } else if (stageId === 'extractSubtitle') {
            if (file.inputSubtitlePath || file.providedSubtitlePath) {
              const source =
                file.inputSubtitlePath || file.providedSubtitlePath;
              const text = await fs.promises.readFile(source, 'utf8');
              const cues = parseSubtitleCues(
                text,
                detectSubtitleFormatFromContent(source, text),
              );
              if (!cues.length) throw new Error('TASK_SUBTITLE_EMPTY');
              file.srtFile = path.join(workspace, 'source.srt');
              await fs.promises.writeFile(
                file.srtFile,
                serializeSubtitleCues(cues, 'srt'),
              );
            } else if (file.embeddedSubtitle) {
              outcome = 'not_applicable';
              reason = 'EMBEDDED_SUBTITLE';
            } else {
              if (config.taskType === 'translateOnly')
                throw new Error('TASK_SUBTITLE_INPUT_REQUIRED');
              file.srtFile = path.join(workspace, 'source.srt');
              // Word timelines are written alongside audio by some adapters; give them a writable copy.
              await writable(file, ['tempAudioFile'], workspace);
              await routeTranscription({
                event,
                file,
                formData: config,
                hasOpenAiWhisper: await checkOpenAiWhisper(),
              });
            }
          } else if (
            stageId === 'refineSubtitle' ||
            stageId === 'manuscriptMatch'
          ) {
            if (
              subtitleInput(ctx.file.input) ||
              file.providedSubtitlePath ||
              file.embeddedSubtitle
            ) {
              outcome = 'not_applicable';
              reason = 'SUPPLIED_SUBTITLE';
            } else {
              await writable(file, ['srtFile'], workspace);
              if (stageId === 'refineSubtitle')
                await runSubtitleRefineStage(event, file, config);
              else await runManuscriptMatchingStage(event, file, config);
              if (file[`${stageId}Error`]) {
                outcome = 'degraded';
                reason = file[`${stageId}Error`];
              }
            }
          } else if (stageId === 'normalizeSubtitle') {
            const script = getDesiredChineseScript(config.sourceLanguage);
            if (
              script &&
              !subtitleInput(ctx.file.input) &&
              !file.providedSubtitlePath
            ) {
              await writable(file, ['srtFile'], workspace);
              const text = await fs.promises.readFile(file.srtFile, 'utf8');
              await fs.promises.writeFile(
                file.srtFile,
                convertChineseText(text, script).text,
              );
            } else outcome = 'not_applicable';
          } else if (stageId === 'summarizeEpisode') {
            await runEpisodeSummaryStage({
              event,
              file,
              formData: config,
              sourceLanguage: config.sourceLanguage,
              targetLanguage: config.targetLanguage,
              translationProvider: (await providers(config))[0],
            });
            if (file.summarizeEpisodeError) {
              outcome = 'degraded';
              reason = file.summarizeEpisodeError;
            }
          } else if (stageId === 'translateSubtitle') {
            const candidates = await providers(config);
            if (!candidates.length)
              throw new Error('TASK_TRANSLATION_PROVIDER_MISSING');
            await translate(
              event,
              file,
              config,
              candidates[0],
              ctx.progress,
              undefined,
              candidates.slice(1),
            );
            if (file.translationFailures?.length) {
              outcome = 'degraded';
              reason = 'TRANSLATION_INCOMPLETE';
            }
          } else if (stageId === 'speakerDiarization') {
            const result = await runSpeakerDiarizationStage({
              file,
              formData: { ...config, speakerDiarizationEmbedInSubtitle: false },
              signal: ctx.signal,
            });
            file.speakerSegmentsFile = path.join(workspace, 'speakers.json');
            await fs.promises.writeFile(
              file.speakerSegmentsFile,
              JSON.stringify(result.segments || []),
            );
            if (result.reason) {
              outcome = 'degraded';
              reason = result.reason;
              file.speakerDiarizationError = reason;
            }
          } else if (stageId === 'annotateSpeakers') {
            if (!config.speakerDiarizationEmbedInSubtitle)
              outcome = 'not_applicable';
            else {
              await writable(
                file,
                ['srtFile', 'translatedSrtFile', 'tempTranslatedSrtFile'],
                workspace,
              );
              const segments = JSON.parse(
                await fs.promises.readFile(file.speakerSegmentsFile, 'utf8'),
              );
              for (const target of new Set<string>(
                [
                  file.srtFile,
                  file.translatedSrtFile,
                  file.tempTranslatedSrtFile,
                ].filter(Boolean),
              )) {
                const text = await fs.promises.readFile(target, 'utf8');
                await fs.promises.writeFile(
                  target,
                  serializeSubtitleCues(
                    annotateCuesWithSpeakers(
                      parseSubtitleCues(text, 'srt'),
                      segments,
                    ),
                    'srt',
                  ),
                );
              }
            }
          } else if (stageId === 'prepareProofread') {
            const result = await writeProofreadDataFromFiles({
              file,
              sourceFile: file.srtFile,
              targetFile: file.tempTranslatedSrtFile || file.translatedSrtFile,
              finalTargetFile: file.translatedSrtFile,
              sourceLanguage: config.sourceLanguage,
              targetLanguage: config.targetLanguage,
              translateContent: config.translateContent,
              outputFormat: resolveSubtitleOutputFormats(config)[0],
              subtitleLayout: config.subtitleLayout,
              subtitleLineWidth: config.subtitleLineWidth,
              speakerSegments: file.speakerSegmentsFile
                ? JSON.parse(
                    await fs.promises.readFile(
                      file.speakerSegmentsFile,
                      'utf8',
                    ),
                  )
                : undefined,
              translationFailures: file.translationFailures,
              missedSpeechWarnings: file.missedSpeechWarnings,
              missedSpeechSummary: file.missedSpeechSummary,
              glossaryIds: config.glossaryIds,
              episodeSummary: file.episodeSummary,
            });
            if (!('filePath' in result))
              throw new Error(`TASK_PROOFREAD_WRITE_FAILED: ${result.reason}`);
            file.proofreadDataFile = result.filePath;
            file.proofreadDataReady = 'done';
          } else if (stageId === 'exportSubtitle') {
            await writable(file, ['proofreadDataFile'], workspace);
            await exportSubtitles(file, config, ctx, workspace);
          } else if (
            stageId === 'subtitleReview' ||
            stageId === 'dubbingReview'
          ) {
            file[
              stageId === 'subtitleReview' ? 'subtitleGate' : 'dubbingGate'
            ] = 'review';
            file.directory = ctx.file.input.directory;
            notifyGateReview(
              ctx.run.projectId,
              stageId === 'subtitleReview' ? 'subtitle' : 'dubbing',
            );
            return {
              reviewRevision: digestValue({
                artifacts: ctx.stage.dependencies.map(
                  (id) => ctx.file.stages[id]?.artifacts,
                ),
                session: file.dubbingSessionId,
              }),
              projection: file,
            };
          } else if (stageId === 'dubbing') {
            if (file.translationFailures?.length)
              throw new Error('TRANSLATION_INCOMPLETE_FOR_DUBBING');
            await runDubStage(event, file, {
              ...config,
              __deferDubTrack: true,
            } as any);
            await snapshotDubbing(file, workspace);
          } else if (stageId === 'dubbingTrack') {
            await rebuildDubTrackForFile(event, file, config);
          } else if (stageId === 'composeVideo') {
            if (file.translationFailures?.length)
              throw new Error('TRANSLATION_INCOMPLETE_FOR_COMPOSE');
            await runComposeStage(event, file, config);
            file.internalFinalVideoPath = path.join(
              workspace,
              `final${path.extname(file.finalVideoPath)}`,
            );
            await copyIndependent(
              file.finalVideoPath,
              file.internalFinalVideoPath,
            );
          }
          ctx.signal?.throwIfAborted();
          // Capture adapter outputs from legacy temp locations before acknowledging success.
          for (const key of pathFields)
            if (
              file[key] &&
              file[key] !== ctx.file.projection[key] &&
              !file[key].startsWith(workspace + path.sep) &&
              fs.existsSync(file[key])
            )
              await writable(file, [key], workspace);
          file.directory = ctx.file.input.directory;
          file[stageId] = 'done';
          file[`${stageId}Progress`] = 100;
          const patch = Object.fromEntries(
            Object.entries(file).filter(
              ([key, value]) =>
                ![
                  'taskActivity',
                  'directory',
                  'stageRuns',
                  'taskRunId',
                  'taskRunRevision',
                ].includes(key) &&
                stableJson(value) !==
                  stableJson((ctx.file.projection as any)[key]),
            ),
          );
          const fingerprint =
            stageId === 'prepareInput'
              ? digestValue({ version: ctx.stage.version, inputDigest })
              : stageFingerprint(ctx.run, ctx.file, stageId);
          const committed = await artifacts.commit(
            ctx.token,
            workspace,
            fingerprint,
            patch,
            ctx.signal,
          );
          const projection = {
            ...ctx.file.projection,
            ...committed.patch,
            directory: ctx.file.input.directory,
          };
          // User editing always targets a separate mutable revision inside this run.
          if (
            projection.proofreadDataFile &&
            ['prepareProofread', 'exportSubtitle'].includes(stageId)
          ) {
            await materializeEditableProofread(projection, ctx, artifacts);
          }
          return {
            outcome,
            reason: reason || decision.reason,
            artifacts: committed.artifacts,
            fingerprint,
            projection,
            inputDigest,
            inputIdentity,
          };
        } finally {
          activity.close();
        }
      },
    );
}
