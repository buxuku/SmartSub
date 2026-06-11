import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import path from 'path';
import { Import, SlidersHorizontal, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn, isSubtitleFile } from 'lib/utils';
import { TASK_TYPES, getTaskTypeBySlug } from 'lib/taskTypes';
import useSystemInfo from 'hooks/useStystemInfo';
import useFormConfig from 'hooks/useFormConfig';
import useIpcCommunication from 'hooks/useIpcCommunication';
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

export default function TaskPage() {
  const router = useRouter();
  const slug = typeof router.query.type === 'string' ? router.query.type : '';
  const typeDef = getTaskTypeBySlug(slug);

  const { t } = useTranslation('tasks');
  const { t: tHome } = useTranslation('home');
  const [files, setFiles] = useState([]);
  const [providers, setProviders] = useState([]);
  const [useLocalWhisper, setUseLocalWhisper] = useState(false);
  const [taskStatus, setTaskStatus] = useState('idle');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [proofreadFile, setProofreadFile] = useState<IFiles | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const { systemInfo } = useSystemInfo();
  const { form, formData } = useFormConfig();
  useIpcCommunication(setFiles);

  useEffect(() => {
    const load = async () => {
      const tasks = await window?.ipc?.invoke('getTasks');
      setFiles(tasks || []);
      const storedProviders = await window?.ipc?.invoke(
        'getTranslationProviders',
      );
      setProviders(storedProviders || []);
      const settings = await window?.ipc?.invoke('getSettings');
      setUseLocalWhisper(settings?.useLocalWhisper || false);
      const status = await window?.ipc?.invoke('getTaskStatus');
      if (status) setTaskStatus(status);
    };
    load();

    const unsubComplete = window?.ipc?.on('taskComplete', (status: string) => {
      setTaskStatus(status);
    });
    return () => {
      unsubComplete?.();
    };
  }, []);

  useEffect(() => {
    window?.ipc?.send('setTasks', files);
  }, [files]);

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

  // 新一轮任务开始时恢复完成横幅
  useEffect(() => {
    if (taskStatus === 'running') setBannerDismissed(false);
  }, [taskStatus]);

  const handleStatusChange = useCallback((status: string) => {
    setTaskStatus(status);
  }, []);

  const handleRetry = useCallback(
    (file: any) => {
      window?.ipc?.send('handleTask', { files: [file], formData });
      setTaskStatus('running');
    },
    [formData],
  );

  const handleRetryFailed = useCallback(
    (failedFiles: any[]) => {
      window?.ipc?.send('handleTask', { files: failedFiles, formData });
      setTaskStatus('running');
    },
    [formData],
  );

  const handleImport = () => {
    const fileType = typeDef?.accepts === 'subtitle' ? 'srt' : 'media';
    window?.ipc?.send('openDialog', { dialogType: 'openDialog', fileType });
  };

  const handleClearList = () => {
    window?.ipc?.send('clearTasks', []);
    setFiles([]);
    setBannerDismissed(false);
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
      // @ts-ignore - Electron File 对象包含 path 属性，支持文件和文件夹
      const filePath = droppedFiles[i].path;
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
          setFiles((prevFiles) => [...prevFiles, ...dropped]);
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
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="text-lg font-semibold whitespace-nowrap">
            {t(`pageTitle.${typeDef.slug}`)}
          </h1>
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {t('configRemembered')}
          </span>
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
            disabled={!files.length}
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
            onStatusChange={handleStatusChange}
          />
        </div>
      </div>

      <LogPanel className="flex-shrink-0" />

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
