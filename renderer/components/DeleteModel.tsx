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
          <AlertDialogCancel onClick={() => setVisibility(false)}>
            {t('cancel')}
          </AlertDialogCancel>
          <AlertDialogAction onClick={handleDelete}>
            {t('delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default DeleteModel;
