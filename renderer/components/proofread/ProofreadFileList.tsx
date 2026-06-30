import React, { useCallback, useState } from 'react';
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
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import {
  PendingFile,
  DetectedSubtitle,
  createPendingFileFromVideo,
  selectBestSubtitles,
  classifySubtitleLang,
} from '@/lib/proofreadUtils';

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
  onReset,
}: ProofreadFileListProps) {
  const { t } = useTranslation('home');
  const [saving, setSaving] = useState(false);
  const [showNameInput, setShowNameInput] = useState(false);

  // 手动选择源字幕
  const handleSelectSourceSubtitle = useCallback(
    async (index: number) => {
      const result = await window.ipc.invoke('selectFiles', {
        type: 'subtitle',
        multiple: false,
      });
      if (result && !result.canceled && result.filePaths.length > 0) {
        const filePath = result.filePaths[0];
        const langResult = await window.ipc.invoke('detectLanguage', {
          filePath,
        });
        const language = langResult.success ? langResult.data?.code : undefined;

        // 检查是否已存在于 detectedSubtitles 中
        const file = files[index];
        const exists = file.detectedSubtitles.some(
          (s) => s.filePath === filePath,
        );

        const updates: Partial<PendingFile> = {
          selectedSource: filePath,
          sourceLanguage: language,
        };

        // 如果不存在，添加到 detectedSubtitles
        if (!exists) {
          updates.detectedSubtitles = [
            ...file.detectedSubtitles,
            {
              filePath,
              type: 'source' as const,
              language,
              confidence: 100, // 手动上传的置信度设为 100
            },
          ];
        }

        onUpdateFile(index, updates);
      }
    },
    [files, onUpdateFile],
  );

  // 手动选择翻译字幕
  const handleSelectTargetSubtitle = useCallback(
    async (index: number) => {
      const result = await window.ipc.invoke('selectFiles', {
        type: 'subtitle',
        multiple: false,
      });
      if (result && !result.canceled && result.filePaths.length > 0) {
        const filePath = result.filePaths[0];
        const langResult = await window.ipc.invoke('detectLanguage', {
          filePath,
        });
        const language = langResult.success ? langResult.data?.code : undefined;

        // 检查是否已存在于 detectedSubtitles 中
        const file = files[index];
        const exists = file.detectedSubtitles.some(
          (s) => s.filePath === filePath,
        );

        const updates: Partial<PendingFile> = {
          selectedTarget: filePath,
          targetLanguage: language,
        };

        // 如果不存在，添加到 detectedSubtitles
        if (!exists) {
          updates.detectedSubtitles = [
            ...file.detectedSubtitles,
            {
              filePath,
              type: 'translated' as const,
              language,
              confidence: 100, // 手动上传的置信度设为 100
            },
          ];
        }

        onUpdateFile(index, updates);
      }
    },
    [files, onUpdateFile],
  );

  // 从下拉菜单选择字幕
  const handleSelectFromDropdown = useCallback(
    (index: number, type: 'source' | 'target', filePath: string) => {
      const file = files[index];
      const subtitle = file.detectedSubtitles.find(
        (s) => s.filePath === filePath,
      );

      if (type === 'source') {
        onUpdateFile(index, {
          selectedSource: filePath,
          sourceLanguage: subtitle?.language,
        });
      } else {
        onUpdateFile(index, {
          selectedTarget: filePath === 'none' ? undefined : filePath,
          targetLanguage: filePath === 'none' ? undefined : subtitle?.language,
        });
      }
    },
    [files, onUpdateFile],
  );

  // 保存任务
  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const success = await onSaveTask();
      if (success) {
        toast.success(t('taskSaved'));
      }
    } catch (error) {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [onSaveTask, t]);

  // 追加文件（根据 importType 自动选择类型）
  const handleAppendFiles = useCallback(async () => {
    try {
      if (importType === 'video') {
        // 追加视频
        const result = await window.ipc.invoke('selectFiles', {
          type: 'video',
          multiple: true,
        });

        if (!result || result.canceled || result.filePaths.length === 0) return;

        // 使用工具函数创建 PendingFile
        const newFiles = await Promise.all(
          result.filePaths.map((videoPath: string) =>
            createPendingFileFromVideo(videoPath),
          ),
        );

        if (newFiles.length > 0) {
          onAddFiles(newFiles);
        }
      } else {
        // 追加字幕
        const result = await window.ipc.invoke('selectFiles', {
          type: 'subtitle',
          multiple: true,
        });

        if (!result || result.canceled || result.filePaths.length === 0) return;

        const allSubtitles: DetectedSubtitle[] = [];
        // 取用户任务语向，用于判定每个字幕是原文还是译文
        const userConfig = await window.ipc.invoke('getUserConfig');

        for (const filePath of result.filePaths) {
          const langResult = await window.ipc.invoke('detectLanguage', {
            filePath,
          });
          const lang = langResult.success ? langResult.data?.code : undefined;
          const type = classifySubtitleLang(
            lang,
            userConfig?.sourceLanguage,
            userConfig?.targetLanguage,
          );
          allSubtitles.push({
            filePath,
            type,
            language: lang,
            confidence: lang ? 90 : 80,
          });
        }

        // 使用工具函数选择最佳字幕
        const { bestSource, bestTarget } = selectBestSubtitles(allSubtitles);
        const sourceSubtitle = bestSource || allSubtitles[0];
        const targetSubtitle =
          bestTarget ||
          allSubtitles.find(
            (s) =>
              s.type === 'translated' &&
              s.filePath !== sourceSubtitle?.filePath,
          );

        const newFile: PendingFile = {
          id: uuidv4(),
          fileName:
            path
              .basename(sourceSubtitle?.filePath || 'Subtitles')
              .replace(/\.[^.]+$/, '') || 'Subtitles',
          detectedSubtitles: allSubtitles,
          selectedSource: sourceSubtitle?.filePath,
          selectedTarget: targetSubtitle?.filePath,
          sourceLanguage: sourceSubtitle?.language,
          targetLanguage: targetSubtitle?.language,
          status: 'pending',
        };

        onAddFiles([newFile]);
      }
    } catch (error) {
      console.error('Failed to append files:', error);
    }
  }, [importType, onAddFiles]);

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
                  disabled={saving || files.length === 0}
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
          {savedTaskId && (
            <Badge variant="outline" className="text-success">
              {t('saved')}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* 追加文件 */}
          <Button variant="outline" size="sm" onClick={handleAppendFiles}>
            <Plus className="w-4 h-4 mr-1" />
            {importType === 'video' ? t('appendVideos') : t('appendSubtitles')}
          </Button>
        </div>
      </div>

      {/* 文件列表表格 */}
      <div className="border rounded-lg overflow-hidden">
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
              const sourceOptions = file.detectedSubtitles.filter(
                (s) => s.type === 'source' || s.type === 'unknown',
              );
              // 如果没有 source 类型，显示所有字幕
              const effectiveSourceOptions =
                sourceOptions.length > 0
                  ? sourceOptions
                  : file.detectedSubtitles;

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
