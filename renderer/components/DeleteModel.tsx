import React from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Trash2, X } from 'lucide-react';
import { useTranslation } from 'next-i18next';
import { toast } from 'sonner';
import type { ModelDownloadFormat } from '@/components/DownModel';

interface DeleteModelProps {
  children: React.ReactNode;
  modelName: string;
  callBack?: () => void;
  format?: ModelDownloadFormat;
}

const DeleteModel = ({
  children,
  modelName,
  callBack,
  format = 'ggml',
}: DeleteModelProps) => {
  const { t } = useTranslation('common');
  const [visibility, setVisibility] = React.useState(false);
  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    const channel = format === 'ct2' ? 'deleteCt2Model' : 'deleteModel';
    const result = await window?.ipc?.invoke(channel, modelName);
    setVisibility(false);
    // 模型路径根下不是 SmartSub 创建的 models--*（可能与其他软件共用的缓存）不会被删。
    // 列表刷新后它仍显示为已安装，这里说明原因，避免“点了删除却没反应”。
    const kept: string[] = result?.skipped ?? [];
    if (kept.length > 0) {
      toast.warning(t('deleteModelKeptExternal', { path: kept.join(', ') }), {
        duration: 8000,
      });
    }
    callBack?.();
  };
  return (
    <AlertDialog open={visibility}>
      <AlertDialogTrigger asChild onClick={() => setVisibility(true)}>
        {children}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('confirmDeleteModel')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('deleteModelDesc')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            className="gap-1.5"
            onClick={() => setVisibility(false)}
          >
            <X className="h-4 w-4" />
            {t('cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            className="gap-1.5 bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            <Trash2 className="h-4 w-4" />
            {t('delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default DeleteModel;
