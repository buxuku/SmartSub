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
  // CT2 模型可能位于与其他软件共用的 HuggingFace 缓存里，删除前把将要删掉的目录列
  // 出来，让用户确认的是一个具体的位置。其他引擎的目录布局固定，保持原来的通用说明。
  const [folders, setFolders] = React.useState<string[]>([]);
  const handleOpen = async () => {
    setVisibility(true);
    if (format !== 'ct2') return;
    setFolders([]);
    try {
      const dirs = await window?.ipc?.invoke('getCt2DeleteTargets', modelName);
      setFolders(Array.isArray(dirs) ? dirs : []);
    } catch {
      // 只是预览：查不到时退回通用说明，不影响删除本身。
    }
  };
  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    const channel = format === 'ct2' ? 'deleteCt2Model' : 'deleteModel';
    await window?.ipc?.invoke(channel, modelName);
    setVisibility(false);
    callBack?.();
  };
  return (
    <AlertDialog open={visibility}>
      <AlertDialogTrigger asChild onClick={handleOpen}>
        {children}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('confirmDeleteModel')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('deleteModelDesc')}
          </AlertDialogDescription>
          {folders.length > 0 && (
            <div className="space-y-1.5 text-sm text-muted-foreground">
              <p>{t('deleteModelFolders')}</p>
              <ul className="space-y-1">
                {folders.map((dir) => (
                  <li
                    key={dir}
                    className="break-all rounded bg-muted px-2 py-1 font-mono text-xs text-foreground"
                  >
                    {dir}
                  </li>
                ))}
              </ul>
              <p>{t('deleteModelSharedNote')}</p>
            </div>
          )}
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
