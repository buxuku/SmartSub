import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/router';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  ArrowLeft,
  AudioLines,
  Check,
  Diamond,
  Edit2,
  Import,
  LayoutGrid,
  List,
  Pencil,
  Play,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn, isSubtitleFile } from 'lib/utils';
import { resolveDefaultTranslateProviderId } from 'lib/providerPanelUtils';
import {
  TASK_TYPES,
  getPipelineTitleKey,
  getTaskTypeBySlug,
} from 'lib/taskTypes';
import {
  getEngineModelGroups,
  isEngineModelSelected,
  pickDefaultEngineModel,
} from 'lib/engineModels';
import { canStartParakeetTask } from 'lib/parakeetTask';
import type { TranscriptionEngine } from '../../../../types/engine';
import type { AsrProvider } from '../../../../types/asrProvider';
import useSystemInfo from 'hooks/useStystemInfo';
import useFormConfig from 'hooks/useFormConfig';
import useIpcCommunication from 'hooks/useIpcCommunication';
import { useConfirmOrUndo } from 'hooks/useConfirmOrUndo';
import { useHotkeys } from 'hooks/useHotkeys';
import TaskControls from '@/components/TaskControls';
import InlineConfigBar from '@/components/tasks/InlineConfigBar';
import SnapshotConfigBar from '@/components/tasks/SnapshotConfigBar';
import AdvancedSheet from '@/components/tasks/AdvancedSheet';
import TaskRowList from '@/components/tasks/TaskRowList';
import TaskGridList from '@/components/tasks/TaskGridList';
import CompletionBanner from '@/components/tasks/CompletionBanner';
import LogPanel from '@/components/tasks/LogPanel';
import { ProofreadEditor } from '@/components/proofread';
import { getProofreadUnavailableReason } from '@/components/tasks/stageUtils';
import {
  isManuscriptPath,
  pairMediaWithManuscriptsManual,
} from '@/lib/filePairing';
import { getI18nProperties } from '../../../lib/get-static';
import { IFiles } from '../../../../types';
import { isPinnedTaskConfigSnapshot } from '../../../../types/taskSnapshot';
import { getProofreadSourcePath } from '../../../../types/subtitleOutput';
import { useTranslation } from 'next-i18next';
import { toast } from 'sonner';

export default function TaskPage() {
  const router = useRouter();
  const slug = typeof router.query.type === 'string' ? router.query.type : '';
  const locale =
    typeof router.query.locale === 'string' ? router.query.locale : 'zh';
  const typeDef = getTaskTypeBySlug(slug);

  const { t } = useTranslation('tasks');
  const confirmOrUndo = useConfirmOrUndo();
  const [files, setFiles] = useState([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [providers, setProviders] = useState([]);
  const [asrProviders, setAsrProviders] = useState<AsrProvider[]>([]);
  /** asrProviders/settings 首次加载是否完成（默认引擎校正须等它，避免按不完整分组误回填） */
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [useLocalWhisper, setUseLocalWhisper] = useState(false);
  const [lastUsedTranscription, setLastUsedTranscription] = useState<{
    engine?: TranscriptionEngine;
    model?: string;
    asrProviderId?: string;
  } | null>(null);
  const [taskStatus, setTaskStatus] = useState('idle');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  /** 固定任务的配置快照（附加阶段/参考文稿）：阶段轨道与横幅按它渲染 */
  const [configSnapshot, setConfigSnapshot] = useState<any>(null);
  const [proofreadFile, setProofreadFile] = useState<IFiles | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const { systemInfo, loaded: systemInfoLoaded } = useSystemInfo();
  const { form, formData } = useFormConfig();
  /** 列表/横幅的有效配置：固定任务用快照，否则使用当前表单。 */
  const listFormData = configSnapshot ?? formData;
  /** 来自加载（而非用户/任务事件）的 files 引用，避免回写存储 */
  const loadedFilesRef = useRef<any[] | null>(null);
  const projectIdRef = useRef<string | null>(null);
  const [manuscriptPool, setManuscriptPool] = useState<IFiles[]>([]);

  const handleIncomingMediaAndManuscripts = useCallback(
    (incomingMedia: IFiles[], incomingManuscripts: IFiles[]) => {
      const seen = new Set(files.map((f) => f.filePath));
      const freshMedia: IFiles[] = [];
      let skipped = 0;
      for (const file of incomingMedia) {
        if (file?.filePath && seen.has(file.filePath)) {
          skipped++;
          continue;
        }
        if (file?.filePath) seen.add(file.filePath);
        freshMedia.push(file);
      }
      if (skipped > 0) {
        toast.info(t('skippedDuplicates', { count: skipped }));
      }

      // 维护文稿池：合并已有的 manuscriptPool 与新传入的 incomingManuscripts
      const poolMap = new Map<string, IFiles>();
      for (const s of manuscriptPool) {
        if (s?.filePath) poolMap.set(s.filePath, s);
      }
      for (const s of incomingManuscripts || []) {
        if (s?.filePath) poolMap.set(s.filePath, s);
      }
      const currentPool = Array.from(poolMap.values());
      if (currentPool.length !== manuscriptPool.length) {
        setManuscriptPool(currentPool);
      }

      const allMedia = [...files, ...freshMedia];

      // 若当前没有媒体文件（仅导入了文稿）
      if (allMedia.length === 0) {
        if (incomingManuscripts && incomingManuscripts.length > 0) {
          if (incomingManuscripts.length === 1) {
            toast.info(
              t('manuscript.poolSingleAddedToast', {
                defaultValue: t('manuscript.poolAddedToast', {
                  count: 1,
                  name: incomingManuscripts[0].fileName,
                }),
                name: incomingManuscripts[0].fileName,
              }),
            );
          } else {
            toast.info(
              t('manuscript.poolAddedToast', {
                count: incomingManuscripts.length,
              }),
            );
          }
        }
        return;
      }

      // 若文稿池为空且没有传入新文稿，直接追加媒体
      if (currentPool.length === 0) {
        if (freshMedia.length > 0) {
          setFiles((prev) => [...prev, ...freshMedia]);
        }
        return;
      }

      // 存在媒体和候选文稿池，执行配对
      const manualPairs = new Map<string, string>();
      for (const m of allMedia) {
        if (m.manuscriptPath) {
          manualPairs.set(m.filePath, m.manuscriptPath);
        }
      }

      const pairing = pairMediaWithManuscriptsManual(
        allMedia,
        currentPool,
        manualPairs,
      );

      const newlyMatched = pairing.pairs.filter(
        (p) => p.media.manuscriptPath !== p.manuscript.filePath,
      );

      const matchedByMediaPath = new Map(
        pairing.pairs.map((p) => [p.media.filePath, p.manuscript]),
      );

      setFiles((prev) => {
        const combined = [...prev, ...freshMedia];
        return combined.map((file) => {
          const matched = matchedByMediaPath.get(file.filePath);
          if (matched && file.manuscriptPath !== matched.filePath) {
            return {
              ...file,
              manuscriptPath: matched.filePath,
              manuscriptName: matched.fileName,
            };
          }
          return file;
        });
      });

      if (newlyMatched.length === 1) {
        toast.success(
          t('manuscript.singleMatchedToast', {
            scriptName: newlyMatched[0].manuscript.fileName,
            videoName: newlyMatched[0].media.fileName,
          }),
        );
      } else if (newlyMatched.length > 1) {
        toast.success(
          t('manuscript.autoMatchedToast', {
            count: newlyMatched.length,
          }),
        );
      }

      // 仅针对本次新增的 incomingManuscripts 中未匹配成功的给出 toast 提示
      if (incomingManuscripts && incomingManuscripts.length > 0) {
        const allMatchedPaths = new Set(
          pairing.pairs.map((p) => p.manuscript.filePath),
        );
        const unmatchedFresh = incomingManuscripts.filter(
          (s) => !allMatchedPaths.has(s.filePath),
        );
        for (const s of unmatchedFresh) {
          toast.info(t('manuscript.unmatchedToast', { name: s.fileName }));
        }
      }
    },
    [files, manuscriptPool, t],
  );

  // 统一导入入口：支持文件选择对话框（file-selected）与外部事件传入
  const appendFiles = useCallback(
    (incoming: IFiles[]) => {
      if (!incoming?.length) return;

      // 若当前任务为需要模型的媒体转写类任务，支持自动分离媒体与参考文稿并进行同名配对
      if (typeDef?.needsModel) {
        const incomingManuscripts = incoming.filter((f) =>
          isManuscriptPath(f.filePath),
        );
        const incomingMedia = incoming.filter(
          (f) => !isManuscriptPath(f.filePath),
        );
        handleIncomingMediaAndManuscripts(incomingMedia, incomingManuscripts);
        return;
      }

      const seen = new Set(files.map((f) => f.filePath));
      const fresh: IFiles[] = [];
      let skipped = 0;
      for (const file of incoming) {
        if (file?.filePath && seen.has(file.filePath)) {
          skipped++;
          continue;
        }
        if (file?.filePath) seen.add(file.filePath);
        fresh.push(file);
      }
      if (fresh.length) setFiles((prev) => [...prev, ...fresh]);
      if (skipped > 0) {
        toast.info(t('skippedDuplicates', { count: skipped }));
      }
    },
    [files, typeDef?.needsModel, handleIncomingMediaAndManuscripts, t],
  );

  const { hydrateFiles } = useIpcCommunication(setFiles, appendFiles);

  useEffect(() => {
    const load = async () => {
      try {
        const storedProviders = await window?.ipc?.invoke(
          'getTranslationProviders',
        );
        setProviders(storedProviders || []);
        const storedAsrProviders = await window?.ipc?.invoke('getAsrProviders');
        setAsrProviders(storedAsrProviders || []);
        const settings = await window?.ipc?.invoke('getSettings');
        setUseLocalWhisper(settings?.useLocalWhisper || false);
        setLastUsedTranscription(settings?.lastUsedTranscription || null);
        if (
          settings?.taskViewMode === 'grid' ||
          settings?.taskViewMode === 'list'
        ) {
          setViewMode(settings.taskViewMode);
        }
      } finally {
        setProvidersLoaded(true);
      }
    };
    load();
  }, []);

  // 任务状态按工程获取与监听
  useEffect(() => {
    if (!projectId) return;
    let disposed = false;
    (async () => {
      const status = await window?.ipc?.invoke('getTaskStatus', projectId);
      if (!disposed && status) setTaskStatus(status);
    })();
    const unsubComplete = window?.ipc?.on(
      'taskComplete',
      (payload: { projectId?: string; status?: string } | string) => {
        const status = typeof payload === 'string' ? payload : payload?.status;
        const pid =
          typeof payload === 'string' ? undefined : payload?.projectId;
        if (pid && pid !== projectId) return;
        if (status) setTaskStatus(status);
      },
    );
    return () => {
      disposed = true;
      unsubComplete?.();
    };
  }, [projectId]);

  // 解析任务工程：带 ?project= 恢复既有工程，否则开新工程
  useEffect(() => {
    if (!router.isReady || !typeDef) return;
    const q =
      typeof router.query.project === 'string' ? router.query.project : '';
    if (q && q === projectIdRef.current) return; // 首次保存后 URL 回填触发，无需重载

    let cancelled = false;
    (async () => {
      let nextFiles: any[] = [];
      let name: string | null = null;
      let snapshot: any = null;
      const id = q || uuidv4();
      if (q) {
        const project = await window?.ipc?.invoke('getTaskProject', q);
        if (project) {
          nextFiles = project.files || [];
          name = project.name || null;
        }
        // 附加阶段、参考文稿及角色分离是任务级输入：创建后固定快照。
        try {
          const workItem = await window?.ipc?.invoke('getWorkItem', q);
          const snap = workItem?.configSnapshot;
          if (isPinnedTaskConfigSnapshot(snap)) snapshot = snap;
        } catch {
          /* ignore */
        }
      }
      if (cancelled) return;
      projectIdRef.current = id;
      // 经 hydrateFiles 合并装载窗口内暂存的任务事件（向导起跑后立刻跳转时，
      // 秒级阶段事件先于文件加载到达），并以实际写入的数组标记「来自加载」。
      loadedFilesRef.current = hydrateFiles(nextFiles);
      if (nextFiles && nextFiles.length > 0) {
        const pool: IFiles[] = [];
        const seen = new Set<string>();
        for (const f of nextFiles) {
          if (
            f.manuscriptPath &&
            f.manuscriptPath !== '__none__' &&
            !seen.has(f.manuscriptPath)
          ) {
            seen.add(f.manuscriptPath);
            pool.push({
              uuid: uuidv4(),
              filePath: f.manuscriptPath,
              fileName:
                f.manuscriptName ||
                f.manuscriptPath
                  .split(/[\\/]/)
                  .pop()
                  ?.replace(/\.[^.]+$/, '') ||
                '',
              originPath: f.manuscriptPath,
              ext: f.manuscriptPath.split('.').pop() || '',
            } as unknown as IFiles);
          }
        }
        setManuscriptPool(pool);
      } else {
        setManuscriptPool([]);
      }
      setProjectName(name);
      setEditingName(false);
      setProjectId(id);
      setConfigSnapshot(snapshot);
      setBannerDismissed(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [router.isReady, router.query.project, slug, typeDef, hydrateFiles]);

  // ?autostart=1 一次性消费进 state 并从 URL 剥离:避免刷新/回退重新触发自动开始
  const [autoStartPending, setAutoStartPending] = useState(false);
  useEffect(() => {
    if (!router.isReady) return;
    if (router.query.autostart === '1') {
      setAutoStartPending(true);
      const { autostart: _autostart, ...rest } = router.query;
      router.replace({ pathname: router.pathname, query: rest }, undefined, {
        shallow: true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, router.query.autostart]);

  // files 变更持久化到任务工程（清空即删除工程）
  useEffect(() => {
    if (!projectId || !typeDef) return;
    if (loadedFilesRef.current === files) return;
    (async () => {
      const saved = await window?.ipc?.invoke('saveTaskProject', {
        id: projectId,
        taskType: typeDef.taskType,
        files,
      });
      setProjectName(saved?.name || null);
      if (saved && router.query.project !== projectId) {
        router.replace(
          {
            pathname: router.pathname,
            query: { ...router.query, project: projectId },
          },
          undefined,
          { shallow: true },
        );
      }
    })();
  }, [files, projectId]);

  // 进入任务页 = 选择任务类型：同步到持久化配置
  useEffect(() => {
    if (!typeDef) return;
    if (
      formData &&
      Object.keys(formData).length > 0 &&
      formData.taskType !== typeDef.taskType
    ) {
      form.setValue('taskType', typeDef.taskType);
    }
  }, [typeDef, formData, form]);

  // 带翻译的任务类型不存在「不翻译」：清理历史残留 '-1' 或已被删除的服务商 id
  useEffect(() => {
    if (!typeDef?.hasTranslate || !providers.length) return;
    if (!formData || Object.keys(formData).length === 0) return; // 配置未加载完
    const current = formData?.translateProvider;
    const valid = providers.some((p: any) => p.id === current);
    if (current && current !== '-1' && valid) return;
    const defaultId = resolveDefaultTranslateProviderId(
      providers as any[],
      current,
    );
    form.setValue('translateProvider', defaultId);
  }, [typeDef, providers, formData?.translateProvider, form]);

  // 默认 (引擎,模型)：取"上次使用"（缺省 builtin + 该引擎首个可用模型），并校验当前
  // (引擎,模型) 仍在分组选项中；失配/未选则回填默认值，避免空模型或悬空引擎直接开跑报错。
  // systemInfo / useLocalWhisper / lastUsed 变化时复跑，修正残留旧选择。
  useEffect(() => {
    if (!typeDef?.needsModel) return;
    // 分组数据源（本地模型清单 / 云实例 / lastUsed）未齐前不校正：早跑会把
    // 仍有效的选择（如云实例）误判失配、回填本地默认并随表单持久化，覆盖用户上次选择。
    if (!systemInfoLoaded || !providersLoaded) return;
    if (!formData || Object.keys(formData).length === 0) return; // 配置未加载完
    const groups = getEngineModelGroups(systemInfo, {
      includeLocalCli: useLocalWhisper,
      asrProviders,
    });
    if (!groups.length) return; // 无可选：保持空，InlineConfigBar 展示「去下载模型」

    const currentValid = groups.some((g) =>
      isEngineModelSelected(g, {
        engine: formData.transcriptionEngine as TranscriptionEngine | undefined,
        model: formData.model,
        asrProviderId: formData.asrProviderId,
      }),
    );
    if (currentValid) return;

    const next = pickDefaultEngineModel(
      groups,
      formData.transcriptionEngine === 'parakeet'
        ? { engine: 'parakeet', model: formData.model }
        : (lastUsedTranscription ?? undefined),
    );
    if (next) {
      form.setValue('transcriptionEngine', next.engine);
      form.setValue('model', next.model);
      form.setValue('asrProviderId', next.asrProviderId ?? '');
    }
  }, [
    typeDef,
    systemInfo,
    systemInfoLoaded,
    providersLoaded,
    useLocalWhisper,
    asrProviders,
    lastUsedTranscription,
    formData?.transcriptionEngine,
    formData?.model,
    formData?.asrProviderId,
    form,
  ]);

  // 「仅生成字幕」任务的源字幕就是最终交付物，不能用 noSave（任务结束会被清理删除）。
  // 修正默认/历史残留的 noSave 或空值，避免视频目录最终没有字幕文件，且下拉框不再显示为空。
  useEffect(() => {
    if (typeDef?.taskType !== 'generateOnly') return;
    if (!formData || Object.keys(formData).length === 0) return;
    const opt = formData.sourceSrtSaveOption;
    if (!opt || opt === 'noSave') {
      form.setValue('sourceSrtSaveOption', 'fileName');
    }
  }, [typeDef, formData?.sourceSrtSaveOption, form]);

  // 新一轮任务开始时恢复完成横幅
  useEffect(() => {
    if (taskStatus === 'running') setBannerDismissed(false);
  }, [taskStatus]);

  const handleStatusChange = useCallback((status: string) => {
    setTaskStatus(status);
  }, []);

  const handleTaskDispatched = useCallback((effectiveFormData: any) => {
    if (isPinnedTaskConfigSnapshot(effectiveFormData)) {
      setConfigSnapshot({ ...effectiveFormData });
    }
  }, []);

  const handleViewModeChange = useCallback((mode: 'list' | 'grid') => {
    setViewMode(mode);
    window?.ipc?.invoke('setSettings', { taskViewMode: mode });
  }, []);

  const retryingRef = useRef(false);
  const handleRetryFiles = useCallback(
    async (retryFiles: any[]) => {
      if (retryingRef.current) return;
      retryingRef.current = true;
      try {
        if (
          !(await canStartParakeetTask(
            retryFiles,
            !!typeDef?.needsModel,
            listFormData,
          ))
        ) {
          toast.error(
            t('parakeet.modelUnavailable', {
              model: listFormData?.model || 'Parakeet',
            }),
          );
          return;
        }
        // 固定任务重试携带其创建时快照，普通任务仍使用当前表单。
        window?.ipc?.send('handleTask', {
          files: retryFiles,
          formData: listFormData,
          projectId,
        });
        setTaskStatus('running');
      } finally {
        retryingRef.current = false;
      }
    },
    [listFormData, projectId, typeDef?.needsModel, t],
  );

  const handleRetry = useCallback(
    (file: any) => handleRetryFiles([file]),
    [handleRetryFiles],
  );

  // ── 人工检查点：统计、放行、检查配音 ─────────────────────────────────────
  const reviewCounts = useMemo(() => {
    let subtitle = 0;
    let dubbing = 0;
    for (const file of files as any[]) {
      if (file?.subtitleGate === 'review') subtitle += 1;
      if (file?.dubbingGate === 'review') dubbing += 1;
    }
    return { subtitle, dubbing };
  }, [files]);

  /** 全部放行确认对话框的目标检查点（null=关闭） */
  const [releaseAllGate, setReleaseAllGate] = useState<
    'subtitle' | 'dubbing' | null
  >(null);

  const handleReleaseGate = useCallback(
    async (gate: 'subtitle' | 'dubbing', fileUuids?: string[]) => {
      if (!projectId) return;
      const result = await window?.ipc?.invoke('pipeline:releaseGate', {
        projectId,
        gate,
        fileUuids,
      });
      if (result?.success) {
        if (result.data?.released > 0) setTaskStatus('running');
      } else {
        toast.error(result?.error || 'release failed');
      }
    },
    [projectId],
  );

  const handleInspectDubbing = useCallback(
    (file: any) => {
      if (!projectId) return;
      const params = new URLSearchParams();
      if (file?.dubbingSessionId) params.set('session', file.dubbingSessionId);
      params.set('gateProject', projectId);
      params.set('gateFile', file?.uuid || '');
      router.push(`/${locale}/dubbing?${params.toString()}`);
    },
    [projectId, router, locale],
  );

  /** 字幕校对点的待校清单（检查员包壳「放行并继续下一个」用） */
  const subtitleReviewQueue = useMemo(
    () => (files as any[]).filter((f) => f?.subtitleGate === 'review'),
    [files],
  );

  const handleReleaseAndNext = useCallback(async () => {
    if (!proofreadFile) return;
    await handleReleaseGate('subtitle', [proofreadFile.uuid]);
    const next = subtitleReviewQueue.find((f) => f.uuid !== proofreadFile.uuid);
    setProofreadFile(next ?? null);
  }, [proofreadFile, subtitleReviewQueue, handleReleaseGate]);

  const handleRetryFailed = handleRetryFiles;

  const handleImport = useCallback(() => {
    const fileType =
      typeDef?.accepts === 'subtitle'
        ? 'srt'
        : typeDef?.needsModel
          ? 'media-and-manuscript'
          : 'media';
    window?.ipc?.send('openDialog', { dialogType: 'openDialog', fileType });
  }, [typeDef]);

  // Cmd/Ctrl+O 导入文件（任务页范围）
  useHotkeys([
    { combo: 'mod+o', allowInInput: true, handler: () => handleImport() },
  ]);

  // 任务运行/取消中禁止破坏性列表操作（删行/清空），避免主进程仍处理已移除文件
  const queueBusy =
    taskStatus === 'running' ||
    taskStatus === 'paused' ||
    taskStatus === 'cancelling';

  const handleClearList = () => {
    if (!files.length || queueBusy) return;
    const prevFiles = files;
    const prevPool = manuscriptPool;
    setFiles([]);
    setManuscriptPool([]);
    setBannerDismissed(false);
    confirmOrUndo(t('listCleared'), () => {
      setFiles(prevFiles);
      setManuscriptPool(prevPool);
    });
  };

  const handleProofread = useCallback(
    (file: IFiles) => {
      if (!typeDef) return;
      const unavailableReason = getProofreadUnavailableReason(file, typeDef);
      if (unavailableReason === 'txt') {
        toast.info(t('row.proofreadTxtUnsupported'));
        return;
      }
      setProofreadFile(file);
    },
    [t, typeDef],
  );

  const startRename = () => {
    setNameDraft(projectName || '');
    setEditingName(true);
  };

  const commitRename = async () => {
    setEditingName(false);
    const name = nameDraft.trim();
    if (!projectId || !name || name === projectName) return;
    const saved = await window?.ipc?.invoke('renameTaskProject', {
      id: projectId,
      name,
    });
    if (saved?.name) setProjectName(saved.name);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleAssignManuscript = useCallback(
    (targetFile: IFiles, manuscriptPath: string, manuscriptName?: string) => {
      if (manuscriptPath && manuscriptPath !== '__none__') {
        const name =
          manuscriptName ||
          manuscriptPath
            .split(/[\\/]/)
            .pop()
            ?.replace(/\.[^.]+$/, '') ||
          '';
        setManuscriptPool((prev) => {
          if (prev.some((f) => f.filePath === manuscriptPath)) return prev;
          return [
            ...prev,
            {
              uuid: uuidv4(),
              filePath: manuscriptPath,
              fileName: name,
              originPath: manuscriptPath,
              ext: manuscriptPath.split('.').pop() || '',
            } as unknown as IFiles,
          ];
        });
      }
      setFiles((prev) =>
        prev.map((f) => {
          if (f.uuid !== targetFile.uuid) return f;
          if (!manuscriptPath) {
            const next = { ...f };
            delete next.manuscriptPath;
            delete next.manuscriptName;
            return next;
          }
          return {
            ...f,
            manuscriptPath,
            manuscriptName:
              manuscriptPath === '__none__'
                ? ''
                : manuscriptName ||
                  manuscriptPath
                    .split(/[\\/]/)
                    .pop()
                    ?.replace(/\.[^.]+$/, '') ||
                  '',
          };
        }),
      );
    },
    [],
  );

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (!typeDef) return;

    const paths: string[] = [];
    const droppedFiles = e.dataTransfer.files;
    for (let i = 0; i < droppedFiles.length; i++) {
      // Electron 32+ 移除 File.path，优先 webUtils；旧 preload 场景回退 .path
      const filePath =
        window?.ipc?.getPathForFile?.(droppedFiles[i]) ??
        (droppedFiles[i] as any).path;
      if (filePath) {
        paths.push(filePath);
      }
    }

    if (paths.length > 0) {
      if (typeDef.accepts === 'subtitle') {
        const dropped = await window?.ipc?.invoke('getDroppedFiles', {
          files: paths,
          taskType: 'translate',
        });
        appendFiles(dropped || []);
      } else {
        const [droppedMedia, droppedManuscript] = await Promise.all([
          window?.ipc?.invoke('getDroppedFiles', {
            files: paths,
            taskType: 'media',
          }),
          window?.ipc?.invoke('getDroppedFiles', {
            files: paths,
            taskType: 'manuscript',
          }),
        ]);
        handleIncomingMediaAndManuscripts(
          droppedMedia || [],
          droppedManuscript || [],
        );
      }
    }
  };

  // 将 IFiles 转换为 ProofreadEditor 需要的 PendingFile 格式（沿用原 home 逻辑）
  const pendingFileForProofread = useMemo(() => {
    if (!proofreadFile || !typeDef) return null;

    const isGenerateOnly = typeDef.taskType === 'generateOnly';

    const videoPath = isSubtitleFile(proofreadFile.filePath)
      ? undefined
      : proofreadFile.filePath;

    const sourceSubtitlePath =
      getProofreadSourcePath(proofreadFile) ||
      (isSubtitleFile(proofreadFile.filePath)
        ? proofreadFile.filePath
        : path.join(proofreadFile.directory, `${proofreadFile.fileName}.srt`));

    const targetSubtitlePath = isGenerateOnly
      ? undefined
      : proofreadFile.tempTranslatedSrtFile || proofreadFile.translatedSrtFile;

    const finalTargetPath = isGenerateOnly
      ? undefined
      : proofreadFile.translatedSrtFile;

    return {
      id: proofreadFile.uuid,
      videoPath,
      fileName: proofreadFile.fileName,
      selectedSource: sourceSubtitlePath,
      selectedTarget: targetSubtitlePath,
      sourceLanguage: listFormData.sourceLanguage,
      targetLanguage: listFormData.targetLanguage,
      status: 'proofreading' as const,
      finalTargetPath,
      translateContent: listFormData.translateContent,
      proofreadDataFile: proofreadFile.proofreadDataFile,
    };
  }, [proofreadFile, typeDef, listFormData]);

  if (!typeDef) return null;

  // 向导任务标题：来自已存配方的任务显示配方名，否则按快照的实际流程
  // （配音/成片）命名，而非固定的字幕段类型
  const pipelineTitleKey = getPipelineTitleKey(configSnapshot, typeDef.accepts);
  const pageTitle =
    configSnapshot?.recipeName ||
    t(`pageTitle.${pipelineTitleKey ?? typeDef.slug}`);

  if (proofreadFile && pendingFileForProofread) {
    // 检查员包壳：停靠在字幕校对点的文件叠加「放行并继续」动线（流式审片）
    const atSubtitleGate = (proofreadFile as any).subtitleGate === 'review';
    const queueIndex = subtitleReviewQueue.findIndex(
      (f) => f.uuid === proofreadFile.uuid,
    );
    return (
      <div className="flex h-full flex-col gap-2 p-4">
        {atSubtitleGate && (
          <div className="flex flex-none flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/[0.06] px-3 py-2">
            <Diamond className="h-3.5 w-3.5 flex-none text-warning" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
              {t('gate.inspectorLabel', {
                index: Math.max(queueIndex, 0) + 1,
                total: subtitleReviewQueue.length,
              })}
              <span className="ml-2 text-muted-foreground">
                {proofreadFile.fileName}
                {proofreadFile.fileExtension}
              </span>
            </span>
            <Button
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={handleReleaseAndNext}
            >
              <Play className="h-3 w-3" />
              {subtitleReviewQueue.length > 1
                ? t('gate.releaseAndNext')
                : t('gate.releaseAndFinish')}
            </Button>
          </div>
        )}
        <div className="min-h-0 flex-1">
          <ProofreadEditor
            file={pendingFileForProofread}
            onMarkComplete={() => setProofreadFile(null)}
            onBack={() => setProofreadFile(null)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2.5 p-3 overflow-hidden">
      <div className="flex items-center justify-between gap-3 flex-shrink-0">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 flex-shrink-0"
                  aria-label={t('backToLaunchpad')}
                  onClick={() => router.push(`/${locale}/home`)}
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t('backToLaunchpad')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <h1
            className="shrink-0 truncate text-lg font-semibold"
            title={pageTitle}
          >
            {pageTitle}
          </h1>
          {editingName ? (
            <div className="flex items-center gap-1 min-w-0">
              <Input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setEditingName(false);
                }}
                onBlur={commitRename}
                className="h-7 w-56 text-xs"
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 flex-shrink-0"
                aria-label={t('renameTask')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={commitRename}
              >
                <Check className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : projectName ? (
            <div className="group/name flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
              <span
                className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                title={projectName}
              >
                {projectName}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 flex-shrink-0 opacity-0 group-hover/name:opacity-100 transition-opacity"
                aria-label={t('renameTask')}
                onClick={startRename}
              >
                <Pencil className="h-3 w-3" />
              </Button>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {t('newTaskHint')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1.5"
            onClick={handleImport}
          >
            <Import className="h-3.5 w-3.5" />
            {t('import')}
          </Button>
          <div className="flex items-center rounded-md border p-0.5">
            <Button
              variant={viewMode === 'list' ? 'secondary' : 'ghost'}
              size="icon"
              className="h-7 w-7"
              aria-label={t('view.list')}
              onClick={() => handleViewModeChange('list')}
            >
              <List className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
              size="icon"
              className="h-7 w-7"
              aria-label={t('view.grid')}
              onClick={() => handleViewModeChange('grid')}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </Button>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1.5"
            onClick={handleClearList}
            disabled={!files.length || queueBusy}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('clearList')}
          </Button>
          {!configSnapshot && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={() => setAdvancedOpen(true)}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {t('advanced')}
            </Button>
          )}
        </div>
      </div>

      <div className="flex-shrink-0">
        {configSnapshot ? (
          // 固定任务：配置随首次派发快照锁定，只读展示实际生效参数。
          <SnapshotConfigBar
            snapshot={configSnapshot}
            files={files}
            typeDef={typeDef}
            providers={providers}
            asrProviders={asrProviders as any}
          />
        ) : (
          <InlineConfigBar
            form={form}
            formData={formData}
            systemInfo={systemInfo}
            providers={providers}
            asrProviders={asrProviders as any}
            typeDef={typeDef}
            useLocalWhisper={useLocalWhisper}
          />
        )}
      </div>

      <CompletionBanner
        files={files}
        typeDef={typeDef}
        formData={listFormData}
        taskStatus={taskStatus}
        dismissed={bannerDismissed}
        projectId={projectId}
        onDismiss={() => setBannerDismissed(true)}
        onProofread={handleProofread}
        onRetryFailed={handleRetryFailed}
      />

      {/* 人工检查点聚合操作条：有停靠文件时常驻 */}
      {(reviewCounts.subtitle > 0 || reviewCounts.dubbing > 0) && (
        <div className="flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-warning/40 bg-warning/[0.06] px-4 py-2.5">
          <Diamond className="h-4 w-4 flex-none text-warning" />
          <div className="min-w-0 flex-1 space-y-0.5 text-sm">
            {reviewCounts.subtitle > 0 && (
              <p className="font-medium">
                {t('gate.barSubtitle', { count: reviewCounts.subtitle })}
              </p>
            )}
            {reviewCounts.dubbing > 0 && (
              <p className="font-medium">
                {t('gate.barDubbing', { count: reviewCounts.dubbing })}
              </p>
            )}
          </div>
          <div className="flex flex-none items-center gap-2">
            {reviewCounts.subtitle > 0 && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={() => {
                    const first = subtitleReviewQueue[0];
                    if (first) setProofreadFile(first);
                  }}
                >
                  <Edit2 className="h-3 w-3" />
                  {t('gate.reviewOneByOne')}
                </Button>
                <Button
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={() => setReleaseAllGate('subtitle')}
                >
                  <Play className="h-3 w-3" />
                  {t('gate.releaseAll')}
                </Button>
              </>
            )}
            {reviewCounts.dubbing > 0 && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={() => {
                    const first = (files as any[]).find(
                      (f) => f?.dubbingGate === 'review',
                    );
                    if (first) handleInspectDubbing(first);
                  }}
                >
                  <AudioLines className="h-3 w-3" />
                  {t('gate.inspectDubbing')}
                </Button>
                <Button
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={() => setReleaseAllGate('dubbing')}
                >
                  <Play className="h-3 w-3" />
                  {t('gate.releaseAll')}
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      <div
        className={cn(
          'relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card p-2.5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:shadow-none dark:[box-shadow:inset_0_1px_0_rgba(255,255,255,0.03)]',
          isDragging && 'border-2 border-dashed border-primary bg-primary/5',
        )}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <ScrollArea className="flex-1 min-h-0">
          {viewMode === 'grid' ? (
            <TaskGridList
              files={files}
              typeDef={typeDef}
              formData={listFormData}
              taskStatus={taskStatus}
              manuscriptPool={manuscriptPool}
              onProofread={handleProofread}
              onDelete={(uuid) =>
                setFiles((prev) => prev.filter((f) => f.uuid !== uuid))
              }
              onRetry={handleRetry}
              onReleaseGate={(file, gate) =>
                handleReleaseGate(gate, [file.uuid])
              }
              onInspectDubbing={handleInspectDubbing}
              onAssignManuscript={handleAssignManuscript}
              onImport={handleImport}
            />
          ) : (
            <TaskRowList
              files={files}
              typeDef={typeDef}
              formData={listFormData}
              taskStatus={taskStatus}
              manuscriptPool={manuscriptPool}
              onProofread={handleProofread}
              onDelete={(uuid) =>
                setFiles((prev) => prev.filter((f) => f.uuid !== uuid))
              }
              onRetry={handleRetry}
              onReleaseGate={(file, gate) =>
                handleReleaseGate(gate, [file.uuid])
              }
              onInspectDubbing={handleInspectDubbing}
              onAssignManuscript={handleAssignManuscript}
              onImport={handleImport}
            />
          )}
        </ScrollArea>
        <div className="mt-3 flex items-center justify-between flex-shrink-0">
          <span className="text-xs text-muted-foreground">
            {files.length > 0 ? t('taskCount', { count: files.length }) : ''}
          </span>
          <TaskControls
            formData={listFormData}
            files={files}
            typeDef={typeDef}
            projectId={projectId}
            onStatusChange={handleStatusChange}
            onTaskDispatched={handleTaskDispatched}
            autoStart={autoStartPending}
          />
        </div>
      </div>

      <LogPanel className="flex-shrink-0" projectId={projectId} />

      <AdvancedSheet
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        form={form}
        formData={formData}
        typeDef={typeDef}
      />

      {/* 全部放行二次确认（含文件数） */}
      <AlertDialog
        open={releaseAllGate !== null}
        onOpenChange={(open) => {
          if (!open) setReleaseAllGate(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('gate.releaseAllTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('gate.releaseAllDesc', {
                count:
                  releaseAllGate === 'subtitle'
                    ? reviewCounts.subtitle
                    : reviewCounts.dubbing,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('gate.releaseAllCancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (releaseAllGate) handleReleaseGate(releaseAllGate);
                setReleaseAllGate(null);
              }}
            >
              {t('gate.releaseAllConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function getStaticPaths() {
  const locales = ['en', 'zh'];
  return {
    fallback: false,
    paths: locales.flatMap((locale) =>
      TASK_TYPES.map((type) => ({
        params: { locale, type: type.slug },
      })),
    ),
  };
}

export async function getStaticProps(context) {
  return {
    props: await getI18nProperties(context, ['common', 'home', 'tasks']),
  };
}
