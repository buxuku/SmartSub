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

const DeleteModel = ({ children, modelName, callBack }) => {
  const { t } = useTranslation('common');
  const [visibility, setVisibility] = React.useState(false);
  const handleDelete = async (e) => {
    e.preventDefault();
    const res = await window?.ipc?.invoke('deleteModel', modelName);
    setVisibility(false);
    callBack && callBack();
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
