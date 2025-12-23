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
  RotateCcw,
  Loader2,
  Edit2,
  Plus,
} from 'lucide-react';
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
} from '@/lib/proofreadUtils';

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
        toast.success(t('taskSaved') || '任务已保存');
      }
    } catch (error) {
      toast.error(t('saveFailed') || '保存失败');
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

        for (const filePath of result.filePaths) {
          const langResult = await window.ipc.invoke('detectLanguage', {
            filePath,
          });
          const lang = langResult.success ? langResult.data?.code : undefined;
          const type =
            lang === 'en' ? 'source' : lang ? 'translated' : 'unknown';
          allSubtitles.push({
            filePath,
            type: type as 'source' | 'translated' | 'unknown',
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
            sourceSubtitle?.filePath
              .split('/')
              .pop()
              ?.replace(/\.[^.]+$/, '') || 'Subtitles',
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
          <div className="flex items-center gap-1 text-green-600 whitespace-nowrap">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            <span className="text-xs">{t('completed') || '已完成'}</span>
          </div>
        );
      case 'proofreading':
        return (
          <div className="flex items-center gap-1 text-primary whitespace-nowrap">
            <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" />
            <span className="text-xs">{t('proofreading') || '校对中'}</span>
          </div>
        );
      default:
        return (
          <div className="flex items-center gap-1 text-muted-foreground whitespace-nowrap">
            <Circle className="w-4 h-4 flex-shrink-0" />
            <span className="text-xs">{t('pending') || '待校对'}</span>
          </div>
        );
    }
  };

  // 格式化文件名显示
  const formatFileName = (filePath: string) => {
    const name = path.basename(filePath);
    return name.length > 30 ? name.slice(0, 27) + '...' : name;
  };

  // 统计完成数
  const completedCount = files.filter((f) => f.status === 'completed').length;

  return (
    <div className="space-y-4">
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          {/* 任务名称 */}
          <Popover open={showNameInput} onOpenChange={setShowNameInput}>
            <PopoverTrigger asChild>
              <div className="flex items-center gap-2 cursor-pointer hover:bg-muted px-2 py-1 rounded">
                <h3
                  className="font-medium max-w-[200px] truncate"
                  title={taskName}
                >
                  {taskName || t('untitledTask') || '未命名任务'}
                </h3>
                <Edit2 className="w-4 h-4 text-muted-foreground" />
              </div>
            </PopoverTrigger>
            <PopoverContent className="w-80">
              <div className="space-y-2">
                <Label>{t('taskName') || '任务名称'}</Label>
                <Input
                  value={taskName}
                  onChange={(e) => onTaskNameChange(e.target.value)}
                  placeholder={t('enterTaskName') || '输入任务名称'}
                />
              </div>
            </PopoverContent>
          </Popover>
          <Badge variant="secondary">
            {completedCount}/{files.length} {t('completed') || '已完成'}
          </Badge>
          {savedTaskId && (
            <Badge variant="outline" className="text-green-600">
              {t('saved') || '已保存'}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* 追加文件 */}
          <Button variant="outline" size="sm" onClick={handleAppendFiles}>
            <Plus className="w-4 h-4 mr-1" />
            {importType === 'video'
              ? t('appendVideos') || '追加视频'
              : t('appendSubtitles') || '追加字幕'}
          </Button>
          <Button variant="outline" size="sm" onClick={onReset}>
            <RotateCcw className="w-4 h-4 mr-1" />
            {t('reset') || '重新导入'}
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={handleSave}
            disabled={saving || files.length === 0}
          >
            {saving ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : (
              <Save className="w-4 h-4 mr-1" />
            )}
            {savedTaskId
              ? t('updateTask') || '更新任务'
              : t('saveTask') || '保存任务'}
          </Button>
        </div>
      </div>

      {/* 文件列表表格 */}
      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">{t('status') || '状态'}</TableHead>
              <TableHead>{t('fileName') || '文件名'}</TableHead>
              <TableHead>{t('sourceSubtitle') || '源字幕'}</TableHead>
              <TableHead>{t('targetSubtitle') || '翻译字幕'}</TableHead>
              <TableHead className="w-32 text-right">
                {t('actions') || '操作'}
              </TableHead>
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

              return (
                <TableRow key={file.id}>
                  <TableCell>{getStatusDisplay(file.status)}</TableCell>
                  <TableCell>
                    <div
                      className="font-medium truncate max-w-[200px]"
                      title={file.fileName}
                    >
                      {file.fileName}
                    </div>
                    {file.videoPath && (
                      <div className="text-xs text-muted-foreground">
                        {t('video') || '视频'}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {/* 字幕导入模式：源字幕固定不可切换 */}
                      {file.isSubtitleOnlyMode ? (
                        <div className="flex items-center gap-2">
                          <span
                            className="text-sm truncate max-w-[200px]"
                            title={file.selectedSource}
                          >
                            {formatFileName(file.selectedSource || '')}
                          </span>
                          {file.sourceLanguage && (
                            <Badge variant="outline" className="text-xs">
                              {file.sourceLanguage}
                            </Badge>
                          )}
                        </div>
                      ) : effectiveSourceOptions.length > 0 ? (
                        <Select
                          value={file.selectedSource || ''}
                          onValueChange={(v) =>
                            handleSelectFromDropdown(index, 'source', v)
                          }
                        >
                          <SelectTrigger className="w-[200px]">
                            <SelectValue
                              placeholder={
                                t('selectSourceSubtitle') || '选择源字幕'
                              }
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {effectiveSourceOptions.map((s, idx) => (
                              <SelectItem
                                key={`source-${idx}-${s.filePath}`}
                                value={s.filePath}
                              >
                                <div className="flex items-center gap-2">
                                  <span className="truncate max-w-[140px]">
                                    {formatFileName(s.filePath)}
                                  </span>
                                  {s.language && (
                                    <Badge
                                      variant="outline"
                                      className="text-xs"
                                    >
                                      {s.language}
                                    </Badge>
                                  )}
                                  <span className="text-xs text-muted-foreground">
                                    {s.confidence}%
                                  </span>
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : file.selectedSource ? (
                        <span
                          className="text-sm truncate max-w-[200px]"
                          title={file.selectedSource}
                        >
                          {formatFileName(file.selectedSource)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-sm">
                          {t('noSubtitle') || '无字幕'}
                        </span>
                      )}
                      {/* 字幕导入模式下隐藏上传按钮 */}
                      {!file.isSubtitleOnlyMode && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => handleSelectSourceSubtitle(index)}
                          title={t('uploadSubtitle') || '上传字幕'}
                        >
                          <Upload className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Select
                        value={file.selectedTarget || 'none'}
                        onValueChange={(v) =>
                          handleSelectFromDropdown(index, 'target', v)
                        }
                      >
                        <SelectTrigger className="w-[200px]">
                          <SelectValue
                            placeholder={
                              t('selectTargetSubtitle') || '选择翻译字幕'
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">
                            {t('noTranslation') || '无翻译字幕'}
                          </SelectItem>
                          {targetOptions.map((s, idx) => (
                            <SelectItem
                              key={`target-${idx}-${s.filePath}`}
                              value={s.filePath}
                            >
                              <div className="flex items-center gap-2">
                                <span className="truncate max-w-[140px]">
                                  {formatFileName(s.filePath)}
                                </span>
                                {s.language && (
                                  <Badge variant="outline" className="text-xs">
                                    {s.language}
                                  </Badge>
                                )}
                                <span className="text-xs text-muted-foreground">
                                  {s.confidence}%
                                </span>
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleSelectTargetSubtitle(index)}
                        title={t('uploadSubtitle') || '上传字幕'}
                      >
                        <Upload className="w-4 h-4" />
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="default"
                        size="sm"
                        onClick={() => onStartProofread(index)}
                        disabled={!file.selectedSource}
                      >
                        <Play className="w-4 h-4 mr-1" />
                        {file.status === 'completed'
                          ? t('view') || '查看'
                          : t('proofread') || '校对'}
                      </Button>
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
          {t('noFiles') || '暂无文件'}
        </div>
      )}
    </div>
  );
}
