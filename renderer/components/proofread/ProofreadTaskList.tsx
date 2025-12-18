import React, { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
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
  Play,
  Trash2,
  Clock,
  CheckCircle2,
  Loader2,
  FileText,
} from 'lucide-react';
import { ProofreadTask } from '../../../types/proofread';

interface ProofreadTaskListProps {
  onLoadTask: (task: ProofreadTask) => void;
}

export default function ProofreadTaskList({
  onLoadTask,
}: ProofreadTaskListProps) {
  const { t } = useTranslation('home');
  const [tasks, setTasks] = useState<ProofreadTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // 加载任务列表
  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.ipc.invoke('getProofreadTasks');
      if (result.success) {
        setTasks(result.data);
      }
    } catch (error) {
      console.error('Failed to load tasks:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  // 删除任务
  const handleDeleteTask = useCallback(
    async (taskId: string) => {
      try {
        const result = await window.ipc.invoke('deleteProofreadTask', {
          taskId,
        });
        if (result.success) {
          await loadTasks();
        }
      } catch (error) {
        console.error('Failed to delete task:', error);
      }
      setDeleteConfirm(null);
    },
    [loadTasks],
  );

  // 计算任务进度
  const getTaskProgress = (task: ProofreadTask) => {
    const completed = task.items.filter((i) => i.status === 'completed').length;
    return {
      completed,
      total: task.items.length,
      percent:
        task.items.length > 0
          ? Math.round((completed / task.items.length) * 100)
          : 0,
    };
  };

  // 格式化时间
  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
        <p>{t('noSavedTasks') || '暂无保存的任务'}</p>
        <p className="text-sm mt-2">
          {t('saveTaskToSeeHere') || '保存任务后会显示在这里'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {tasks.map((task) => {
        const progress = getTaskProgress(task);
        return (
          <Card key={task.id} className="hover:bg-accent/50 transition-colors">
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2">
                    <h3 className="font-medium truncate">{task.name}</h3>
                    {task.status === 'completed' ? (
                      <Badge variant="outline" className="text-green-600">
                        <CheckCircle2 className="w-3 h-3 mr-1" />
                        {t('completed') || '已完成'}
                      </Badge>
                    ) : (
                      <Badge variant="outline">
                        <Clock className="w-3 h-3 mr-1" />
                        {t('inProgress') || '进行中'}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-4 text-sm text-muted-foreground mb-2">
                    <span>
                      {t('itemsCount', { count: task.items.length }) ||
                        `${task.items.length} 个文件`}
                    </span>
                    <span>{formatDate(task.updatedAt)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Progress value={progress.percent} className="flex-1 h-2" />
                    <span className="text-xs text-muted-foreground w-20 text-right">
                      {progress.completed}/{progress.total} ({progress.percent}
                      %)
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => onLoadTask(task)}
                  >
                    <Play className="w-4 h-4 mr-1" />
                    {task.status === 'completed'
                      ? t('view') || '查看'
                      : t('continue') || '继续'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setDeleteConfirm(task.id)}
                  >
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}

      {/* 删除确认对话框 */}
      <AlertDialog
        open={!!deleteConfirm}
        onOpenChange={() => setDeleteConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('confirmDelete') || '确认删除'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('deleteTaskConfirmDesc') ||
                '确定要删除这个任务吗？此操作不可恢复。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel') || '取消'}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteConfirm && handleDeleteTask(deleteConfirm)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('delete') || '删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
