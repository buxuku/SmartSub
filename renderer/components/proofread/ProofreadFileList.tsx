import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Play,
  Trash2,
  Save,
  CheckCircle2,
  Circle,
  Upload,
  ArrowLeft,
  Loader2,
  Edit2,
  Plus,
  HelpCircle,
} from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Label } from '@/components/ui/label';
import path from 'path';
import {
  PendingFile,
  DetectedSubtitle,
  createPendingFileFromVideo,
  createPendingFileFromSubtitle,
} from '@/lib/proofreadUtils';
import { useProofreadAction } from '../../hooks/useProofreadAction';
import { ProofreadActionStatus } from './ProofreadActionStatus';
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

const SUBTITLE_SELECT_TRIGGER_CLASS =
  'h-auto min-h-10 w-full min-w-0 max-w-full [&>span]:line-clamp-none [&>span]:flex [&>span]:min-w-0 [&>span]:flex-1 [&>span]:w-full';

function isPlainTextSubtitlePath(filePath?: string): boolean {
  return /\.txt$/i.test(filePath || '');
}

interface SubtitleSelectLabelProps {
  filePath: string;
  language?: string;
  confidence?: number;
}

function SubtitleSelectLabel({
  filePath,
  language,
  confidence,
}: SubtitleSelectLabelProps) {
  const { t } = useTranslation('home');
  const name = path.basename(filePath);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="truncate" title={name}>
        {name}
      </span>
      {language ? (
        <Badge variant="outline" className="shrink-0 text-xs">
          {language}
        </Badge>
      ) : null}
      {confidence != null ? (
        <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
          {t('matchConfidence', { percent: confidence })}
        </span>
      ) : null}
    </div>
  );
}

interface SubtitleSelectTriggerProps {
  placeholder: string;
  selected?: DetectedSubtitle;
  emptyLabel?: string;
}

function SubtitleSelectTrigger({
  placeholder,
  selected,
  emptyLabel,
}: SubtitleSelectTriggerProps) {
  return (
    <SelectValue asChild placeholder={placeholder}>
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden pr-1 text-left">
        {selected ? (
          <SubtitleSelectLabel
            filePath={selected.filePath}
            language={selected.language}
            confidence={selected.confidence}
          />
        ) : (
          <span className="truncate text-muted-foreground">
            {emptyLabel ?? placeholder}
          </span>
        )}
      </div>
    </SelectValue>
  );
}

interface ProofreadFileListProps {
  files: PendingFile[];
  savedTaskId: string | null;
  taskName: string;
  importType: 'video' | 'subtitle';
  onTaskNameChange: (name: string) => void;
  onStartProofread: (index: number) => void;
  onUpdateFile: (index: number, updates: Partial<PendingFile>) => void;
  onRemoveFile: (index: number) => void;
  onAddFiles: (files: PendingFile[]) => void;
  onSaveTask: () => Promise<boolean>;
  saveStatus: 'idle' | 'saving' | 'saved' | 'save_error';
  isDirty: boolean;
  onReset: () => void;
}

export default function ProofreadFileList({
  files,
  savedTaskId,
  taskName,
  importType,
  onTaskNameChange,
  onStartProofread,
  onUpdateFile,
  onRemoveFile,
  onAddFiles,
  onSaveTask,
  saveStatus,
  isDirty,
  onReset,
}: ProofreadFileListProps) {
  const { t } = useTranslation('home');
  const { t: commonT } = useTranslation('common');
  const saving = saveStatus === 'saving';
  const [showNameInput, setShowNameInput] = useState(false);
  const action = useProofreadAction();
  const filesRef = useRef(files);
  filesRef.current = files;
  const [selectionError, setSelectionError] = useState('');
  const [replacement, setReplacement] = useState<{
    file: PendingFile;
    updates: Partial<PendingFile>;
  } | null>(null);

  const changeSubtitle = (
    id: string,
    type: 'source' | 'target',
    filePath?: string,
    language?: string,
  ) => {
    const index = filesRef.current.findIndex((file) => file.id === id);
    const file = filesRef.current[index];
    if (!file) return;
    setSelectionError('');
    if (
      filePath &&
      filePath ===
        (type === 'source' ? file.selectedTarget : file.selectedSource)
    ) {
      setSelectionError(t('proofreadImportState.sameFile'));
      return;
    }
    const previousPath =
      type === 'source' ? file.selectedSource : file.selectedTarget;
    if (previousPath === filePath) return;
    const updates: Partial<PendingFile> = {
      ...(type === 'source'
        ? { selectedSource: filePath, sourceLanguage: language }
        : { selectedTarget: filePath, targetLanguage: language }),
      proofreadDataFile: undefined,
      finalTargetPath: undefined,
      translateContent: undefined,
      status: 'pending',
      ...(filePath &&
      !file.detectedSubtitles.some((subtitle) => subtitle.filePath === filePath)
        ? {
            detectedSubtitles: [
              ...file.detectedSubtitles,
              {
                filePath,
                language,
                type: type === 'source' ? 'source' : 'translated',
                confidence: 100,
              },
            ],
          }
        : {}),
    };
    if (file.proofreadDataFile) setReplacement({ file, updates });
    else onUpdateFile(index, updates);
  };

  const confirmReplacement = () => {
    if (!replacement) return;
    const index = filesRef.current.findIndex(
      (file) => file.id === replacement.file.id,
    );
    const file = filesRef.current[index];
    // A confirmation only applies to the document the user actually reviewed.
    if (
      file &&
      file.selectedSource === replacement.file.selectedSource &&
      file.selectedTarget === replacement.file.selectedTarget &&
      file.proofreadDataFile === replacement.file.proofreadDataFile
    )
      onUpdateFile(index, replacement.updates);
    setReplacement(null);
  };

  const handleSelectSubtitle = (index: number, type: 'source' | 'target') => {
    setSelectionError('');
    const id = files[index]?.id;
    if (!id) return;
    let selection: { canceled?: boolean; filePaths: string[] } | undefined;
    void action.run(
      async (invoke) => {
        if (!filesRef.current.some((file) => file.id === id)) return null;
        selection ||= await invoke('selectFiles', {
          type: 'subtitle',
          multiple: false,
        });
        if (selection?.canceled) return null;
        if (!Array.isArray(selection?.filePaths))
          throw new Error('INVALID_FILE_SELECTION');
        const filePath = selection.filePaths[0];
        if (!filePath) return null;
        if ((await invoke('checkFileExists', { filePath }))?.exists !== true)
          throw new Error(`File not found: ${filePath}`);
        const language = await invoke('detectLanguage', { filePath });
        if (language?.success !== true)
          throw new Error(language?.error || 'INVALID_LANGUAGE_RESPONSE');
        return { filePath, language: language.data?.code };
      },
      (result) => {
        if (!result) return;
        changeSubtitle(id, type, result.filePath, result.language);
      },
    );
  };
  const handleSelectSourceSubtitle = (index: number) =>
    handleSelectSubtitle(index, 'source');
  const handleSelectTargetSubtitle = (index: number) =>
    handleSelectSubtitle(index, 'target');

  // 从下拉菜单选择字幕
  const handleSelectFromDropdown = (
    index: number,
    type: 'source' | 'target',
    filePath: string,
  ) => {
    const file = files[index];
    const subtitle = file.detectedSubtitles.find(
      (s) => s.filePath === filePath,
    );

    changeSubtitle(
      file.id,
      type,
      filePath === 'none' ? undefined : filePath,
      filePath === 'none' ? undefined : subtitle?.language,
    );
  };

  // 保存任务
  const handleSave = useCallback(async () => {
    try {
      const success = await onSaveTask();
      if (success) {
        toast.success(t('taskSaved'));
      }
    } catch (error) {
      toast.error(t('saveFailed'));
    }
  }, [onSaveTask, t]);

  // 追加文件（根据 importType 自动选择类型）
  const handleAppendFiles = () => {
    setSelectionError('');
    let selection: { canceled?: boolean; filePaths: string[] } | undefined;
    void action.run(
      async (invoke) => {
        selection ||= await invoke('selectFiles', {
          type: importType,
          multiple: true,
        });
        if (selection?.canceled) return [];
        if (!Array.isArray(selection?.filePaths))
          throw new Error('INVALID_FILE_SELECTION');
        const paths = Array.from(new Set(selection.filePaths));
        if (!paths.length) return [];
        return Promise.all(
          paths.map((filePath) =>
            importType === 'video'
              ? createPendingFileFromVideo(filePath, { strict: true })
              : createPendingFileFromSubtitle(filePath, true, { strict: true }),
          ),
        );
      },
      (newFiles) => {
        if (newFiles.length) onAddFiles(newFiles);
      },
    );
  };

  // 获取状态显示
  const getStatusDisplay = (status: PendingFile['status']) => {
    switch (status) {
      case 'completed':
        return (
          <div className="flex items-center gap-1 text-success whitespace-nowrap">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            <span className="text-xs">{t('completed')}</span>
          </div>
        );
      case 'proofreading':
        return (
          <div className="flex items-center gap-1 text-primary whitespace-nowrap">
            <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" />
            <span className="text-xs">{t('proofreading')}</span>
          </div>
        );
      default:
        return (
          <div className="flex items-center gap-1 text-muted-foreground whitespace-nowrap">
            <Circle className="w-4 h-4 flex-shrink-0" />
            <span className="text-xs">{t('pending')}</span>
          </div>
        );
    }
  };

  // 格式化文件名显示（仅用于无 Select 的静态展示）
  const formatFileName = (filePath: string) => path.basename(filePath);

  // 统计完成数
  const completedCount = files.filter((f) => f.status === 'completed').length;

  return (
    <div className="space-y-4">
      <ProofreadActionStatus {...action} />
      {selectionError && (
        <p role="alert" className="bg-destructive/10 p-3 text-sm">
          {selectionError}
        </p>
      )}
      <AlertDialog
        open={Boolean(replacement)}
        onOpenChange={(open) => !open && setReplacement(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('proofreadImportState.replaceTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('proofreadImportState.replaceDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmReplacement}>
              {t('proofreadImportState.replaceConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          {/* 返回导入（二级页统一用返回箭头表达，避免「重新导入」按钮被误解为在当前页导入） */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 flex-shrink-0"
                  aria-label={t('backToImport')}
                  onClick={onReset}
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('backToImport')}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {/* 任务名称 */}
          <Popover open={showNameInput} onOpenChange={setShowNameInput}>
            <PopoverTrigger asChild>
              <div className="flex items-center gap-2 cursor-pointer hover:bg-muted px-2 py-1 rounded">
                <h3
                  className="font-medium max-w-[200px] truncate"
                  title={taskName}
                >
                  {taskName || t('untitledTask')}
                </h3>
                <Edit2 className="w-4 h-4 text-muted-foreground" />
              </div>
            </PopoverTrigger>
            <PopoverContent className="w-80">
              <div className="space-y-2">
                <Label>{t('taskName')}</Label>
                <Input
                  value={taskName}
                  onChange={(e) => onTaskNameChange(e.target.value)}
                  placeholder={t('enterTaskName')}
                />
              </div>
            </PopoverContent>
          </Popover>
          {/* 保存到历史：紧邻任务名编辑，符合「命名→保存」操作路径；次要按钮样式 */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSave}
                  disabled={saving || (files.length === 0 && !savedTaskId)}
                >
                  {saving ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4 mr-1" />
                  )}
                  {t('saveTask')}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[280px]">
                <p>{savedTaskId ? t('updateTaskTip') : t('saveTaskTip')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Badge variant="secondary">
            {completedCount}/{files.length} {t('completed')}
          </Badge>
          <span
            role="status"
            className={
              saveStatus === 'save_error'
                ? 'text-xs text-destructive'
                : 'text-xs text-muted-foreground'
            }
          >
            {commonT(
              `saveState.${saveStatus === 'idle' && isDirty ? 'dirty' : saveStatus}`,
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* 追加文件 */}
          <Button
            variant="outline"
            size="sm"
            disabled={action.busy}
            onClick={handleAppendFiles}
          >
            <Plus className="w-4 h-4 mr-1" />
            {importType === 'video' ? t('appendVideos') : t('appendSubtitles')}
          </Button>
        </div>
      </div>

      {/* 文件列表表格 */}
      <div className="rounded-lg bg-card overflow-hidden">
        <Table className="table-fixed w-full">
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">{t('status')}</TableHead>
              <TableHead className="w-[18%]">{t('fileName')}</TableHead>
              <TableHead className="w-[26%]">
                <div className="flex items-center gap-1">
                  {t('sourceSubtitle')}
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="max-w-[280px]">
                          {t('matchConfidenceTip')}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </TableHead>
              <TableHead className="w-[26%]">
                <div className="flex items-center gap-1">
                  {t('targetSubtitle')}
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="max-w-[280px]">
                          {t('matchConfidenceTip')}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </TableHead>
              <TableHead className="w-36 text-right">{t('actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {files.map((file, index) => {
              // 所有字幕都可以作为源字幕或翻译字幕选择
              // 源字幕优先显示 source 和 unknown 类型
              const availableSources = file.detectedSubtitles.filter(
                (s) => s.filePath !== file.selectedTarget,
              );
              const sourceOptions = availableSources.filter(
                (s) => s.type === 'source' || s.type === 'unknown',
              );
              // 如果没有 source 类型，显示所有字幕
              const effectiveSourceOptions =
                sourceOptions.length > 0 ? sourceOptions : availableSources;

              // 翻译字幕可以选择任何字幕（除了已选为源的那个）
              // 优先显示 translated 类型，但也允许选择其他类型
              const targetOptions = file.detectedSubtitles.filter(
                (s) => s.filePath !== file.selectedSource,
              );
              const hasPlainTextSubtitle =
                !file.proofreadDataFile &&
                (isPlainTextSubtitlePath(file.selectedSource) ||
                  isPlainTextSubtitlePath(file.selectedTarget));
              const canStartProofread =
                Boolean(file.selectedSource) && !hasPlainTextSubtitle;

              return (
                <TableRow key={file.id}>
                  <TableCell>{getStatusDisplay(file.status)}</TableCell>
                  <TableCell>
                    <div className="font-medium truncate" title={file.fileName}>
                      {file.fileName}
                    </div>
                    {file.videoPath && (
                      <div className="text-xs text-muted-foreground">
                        {t('video')}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      {/* 字幕导入模式：源字幕固定不可切换 */}
                      {file.isSubtitleOnlyMode ? (
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <span
                            className="truncate text-sm"
                            title={file.selectedSource}
                          >
                            {formatFileName(file.selectedSource || '')}
                          </span>
                          {file.sourceLanguage && (
                            <Badge
                              variant="outline"
                              className="shrink-0 text-xs"
                            >
                              {file.sourceLanguage}
                            </Badge>
                          )}
                        </div>
                      ) : effectiveSourceOptions.length > 0 ? (
                        <div className="min-w-0 flex-1">
                          <Select
                            disabled={action.busy}
                            value={file.selectedSource || ''}
                            onValueChange={(v) =>
                              handleSelectFromDropdown(index, 'source', v)
                            }
                          >
                            <SelectTrigger
                              className={SUBTITLE_SELECT_TRIGGER_CLASS}
                            >
                              <SubtitleSelectTrigger
                                placeholder={t('selectSourceSubtitle')}
                                selected={effectiveSourceOptions.find(
                                  (s) => s.filePath === file.selectedSource,
                                )}
                              />
                            </SelectTrigger>
                            <SelectContent className="min-w-[var(--radix-select-trigger-width)]">
                              {effectiveSourceOptions.map((s, idx) => (
                                <SelectItem
                                  key={`source-${idx}-${s.filePath}`}
                                  value={s.filePath}
                                  textValue={path.basename(s.filePath)}
                                >
                                  <SubtitleSelectLabel
                                    filePath={s.filePath}
                                    language={s.language}
                                    confidence={s.confidence}
                                  />
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ) : file.selectedSource ? (
                        <span
                          className="truncate text-sm"
                          title={file.selectedSource}
                        >
                          {formatFileName(file.selectedSource)}
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          {t('noSubtitle')}
                        </span>
                      )}
                      {/* 字幕导入模式下隐藏上传按钮 */}
                      {!file.isSubtitleOnlyMode && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => handleSelectSourceSubtitle(index)}
                          title={t('uploadSubtitle')}
                          disabled={action.busy}
                        >
                          <Upload className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <Select
                          disabled={action.busy}
                          value={file.selectedTarget || 'none'}
                          onValueChange={(v) =>
                            handleSelectFromDropdown(index, 'target', v)
                          }
                        >
                          <SelectTrigger
                            className={SUBTITLE_SELECT_TRIGGER_CLASS}
                          >
                            <SubtitleSelectTrigger
                              placeholder={t('selectTargetSubtitle')}
                              emptyLabel={t('noTranslation')}
                              selected={
                                file.selectedTarget
                                  ? targetOptions.find(
                                      (s) => s.filePath === file.selectedTarget,
                                    )
                                  : undefined
                              }
                            />
                          </SelectTrigger>
                          <SelectContent className="min-w-[var(--radix-select-trigger-width)]">
                            <SelectItem
                              value="none"
                              textValue={t('noTranslation')}
                            >
                              {t('noTranslation')}
                            </SelectItem>
                            {targetOptions.map((s, idx) => (
                              <SelectItem
                                key={`target-${idx}-${s.filePath}`}
                                value={s.filePath}
                                textValue={path.basename(s.filePath)}
                              >
                                <SubtitleSelectLabel
                                  filePath={s.filePath}
                                  language={s.language}
                                  confidence={s.confidence}
                                />
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleSelectTargetSubtitle(index)}
                        title={t('uploadSubtitle')}
                        disabled={action.busy}
                      >
                        <Upload className="w-4 h-4" />
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex">
                              <Button
                                variant="default"
                                size="sm"
                                onClick={() => onStartProofread(index)}
                                disabled={!canStartProofread}
                              >
                                <Play className="w-4 h-4 mr-1" />
                                {file.status === 'completed'
                                  ? t('view')
                                  : t('proofread')}
                              </Button>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[280px]">
                            {hasPlainTextSubtitle
                              ? t('proofreadTxtUnsupported')
                              : t('proofread')}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => onRemoveFile(index)}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {files.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          {t('noFiles')}
        </div>
      )}
    </div>
  );
}
