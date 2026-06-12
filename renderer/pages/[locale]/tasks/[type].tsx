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
  Check,
  Import,
  Pencil,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn, isSubtitleFile } from 'lib/utils';
import { isProviderConfigured } from 'lib/providerUtils';
import { TASK_TYPES, getTaskTypeBySlug } from 'lib/taskTypes';
import useSystemInfo from 'hooks/useStystemInfo';
import useFormConfig from 'hooks/useFormConfig';
import useIpcCommunication from 'hooks/useIpcCommunication';
import { useConfirmOrUndo } from 'hooks/useConfirmOrUndo';
import { useHotkeys } from 'hooks/useHotkeys';
import TaskControls from '@/components/TaskControls';
import InlineConfigBar from '@/components/tasks/InlineConfigBar';
import AdvancedSheet from '@/components/tasks/AdvancedSheet';
import TaskRowList from '@/components/tasks/TaskRowList';
import CompletionBanner from '@/components/tasks/CompletionBanner';
import LogPanel from '@/components/tasks/LogPanel';
import { ProofreadEditor } from '@/components/proofread';
import { getI18nProperties } from '../../../lib/get-static';
import { IFiles } from '../../../../types';
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
  const [useLocalWhisper, setUseLocalWhisper] = useState(false);
  const [taskStatus, setTaskStatus] = useState('idle');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [proofreadFile, setProofreadFile] = useState<IFiles | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const { systemInfo } = useSystemInfo();
  const { form, formData } = useFormConfig();
  /** 来自加载（而非用户/任务事件）的 files 引用，避免回写存储 */
  const loadedFilesRef = useRef<any[] | null>(null);
  const projectIdRef = useRef<string | null>(null);

  // 统一导入入口：按 filePath 去重（对既有列表与本批内部），跳过时提示
  const appendFiles = useCallback(
    (incoming: IFiles[]) => {
      if (!incoming?.length) return;
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
    [files, t],
  );

  useIpcCommunication(setFiles, appendFiles);

  useEffect(() => {
    const load = async () => {
      const storedProviders = await window?.ipc?.invoke(
        'getTranslationProviders',
      );
      setProviders(storedProviders || []);
      const settings = await window?.ipc?.invoke('getSettings');
      setUseLocalWhisper(settings?.useLocalWhisper || false);
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
      const id = q || uuidv4();
      if (q) {
        const project = await window?.ipc?.invoke('getTaskProject', q);
        if (project) {
          nextFiles = project.files || [];
          name = project.name || null;
        }
      }
      if (cancelled) return;
      loadedFilesRef.current = nextFiles;
      projectIdRef.current = id;
      setFiles(nextFiles);
      setProjectName(name);
      setEditingName(false);
      setProjectId(id);
      setBannerDismissed(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [router.isReady, router.query.project, slug, typeDef]);

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
    const firstConfigured = providers.find((p: any) =>
      isProviderConfigured(p),
    ) as any;
    form.setValue('translateProvider', firstConfigured?.id ?? '');
  }, [typeDef, providers, formData?.translateProvider, form]);

  // 新一轮任务开始时恢复完成横幅
  useEffect(() => {
    if (taskStatus === 'running') setBannerDismissed(false);
  }, [taskStatus]);

  const handleStatusChange = useCallback((status: string) => {
    setTaskStatus(status);
  }, []);

  const handleRetry = useCallback(
    (file: any) => {
      window?.ipc?.send('handleTask', { files: [file], formData, projectId });
      setTaskStatus('running');
    },
    [formData, projectId],
  );

  const handleRetryFailed = useCallback(
    (failedFiles: any[]) => {
      window?.ipc?.send('handleTask', {
        files: failedFiles,
        formData,
        projectId,
      });
      setTaskStatus('running');
    },
    [formData, projectId],
  );

  const handleImport = () => {
    const fileType = typeDef?.accepts === 'subtitle' ? 'srt' : 'media';
    window?.ipc?.send('openDialog', { dialogType: 'openDialog', fileType });
  };

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
    setFiles([]);
    setBannerDismissed(false);
    confirmOrUndo(t('listCleared') || '已清空文件列表', () => {
      setFiles(prevFiles);
    });
  };

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

  const handleDrop = (e: React.DragEvent) => {
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
      window?.ipc
        ?.invoke('getDroppedFiles', {
          files: paths,
          taskType: typeDef.accepts === 'subtitle' ? 'translate' : 'media',
        })
        .then((dropped) => {
          appendFiles(dropped);
        });
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
      proofreadFile.srtFile ||
      proofreadFile.tempSrtFile ||
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
      sourceLanguage: formData.sourceLanguage,
      targetLanguage: formData.targetLanguage,
      status: 'proofreading' as const,
      finalTargetPath,
      translateContent: formData.translateContent,
    };
  }, [proofreadFile, typeDef, formData]);

  if (!typeDef) return null;

  if (proofreadFile && pendingFileForProofread) {
    return (
      <div className="h-full p-4">
        <ProofreadEditor
          file={pendingFileForProofread}
          onMarkComplete={() => setProofreadFile(null)}
          onBack={() => setProofreadFile(null)}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4 overflow-hidden">
      <div className="flex items-center justify-between gap-3 flex-wrap flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
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
          <h1 className="text-lg font-semibold whitespace-nowrap">
            {t(`pageTitle.${typeDef.slug}`)}
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
            <div className="group/name flex items-center gap-1 min-w-0">
              <span className="truncate text-xs text-muted-foreground min-w-0">
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
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1.5"
            onClick={() => setAdvancedOpen(true)}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            {t('advanced')}
          </Button>
        </div>
      </div>

      <div className="flex-shrink-0">
        <InlineConfigBar
          form={form}
          formData={formData}
          systemInfo={systemInfo}
          providers={providers}
          typeDef={typeDef}
          useLocalWhisper={useLocalWhisper}
        />
      </div>

      <CompletionBanner
        files={files}
        typeDef={typeDef}
        formData={formData}
        taskStatus={taskStatus}
        dismissed={bannerDismissed}
        onDismiss={() => setBannerDismissed(true)}
        onProofread={(file) => setProofreadFile(file)}
        onRetryFailed={handleRetryFailed}
      />

      <div
        className={cn(
          'relative flex min-h-0 flex-1 flex-col rounded-xl border p-3 overflow-hidden',
          isDragging && 'border-2 border-dashed border-primary bg-muted/50',
        )}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <ScrollArea className="flex-1 min-h-0">
          <TaskRowList
            files={files}
            typeDef={typeDef}
            formData={formData}
            taskStatus={taskStatus}
            onProofread={(file) => setProofreadFile(file)}
            onDelete={(uuid) =>
              setFiles((prev) => prev.filter((f) => f.uuid !== uuid))
            }
            onRetry={handleRetry}
          />
        </ScrollArea>
        <div className="mt-3 flex items-center justify-between flex-shrink-0">
          <span className="text-xs text-muted-foreground">
            {files.length > 0 ? t('taskCount', { count: files.length }) : ''}
          </span>
          <TaskControls
            formData={formData}
            files={files}
            typeDef={typeDef}
            projectId={projectId}
            onStatusChange={handleStatusChange}
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
