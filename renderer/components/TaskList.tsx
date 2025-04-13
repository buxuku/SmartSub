import React from 'react';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import TaskStatus from './TaskStatus';
import { isSubtitleFile } from 'lib/utils';
import { useTranslation } from 'next-i18next';
import { Upload, FileUp } from 'lucide-react';

const TaskList = ({ files = [], formData }) => {
  const { t } = useTranslation('home');
  const { taskType } = formData;
  // 根据任务类型确定要显示的列
  const shouldShowAudioColumn = taskType !== 'translateOnly';
  const shouldShowSubtitleColumn = taskType !== 'translateOnly';
  const shouldShowTranslateColumn = taskType !== 'generateOnly';

  const handleImport = async () => {
    const fileType = taskType === 'translateOnly' ? 'srt' : 'media';
    window?.ipc?.send('openDialog', { dialogType: 'openDialog', fileType });
  };

  // 空状态提示
  if (!files.length) {
    return (
      <div
        className="flex flex-col cursor-pointer items-center justify-center h-[400px] border-2 border-dashed rounded-lg p-8"
        onClick={handleImport}
      >
        <FileUp className="w-16 h-16 text-gray-400 mb-4" />
        <p className="text-lg text-center text-gray-500 mb-2">
          {taskType === 'translateOnly'
            ? t('dragSubtitleHere')
            : t('dragMediaHere')}
        </p>
        <p className="text-sm text-center text-gray-400">
          {taskType === 'translateOnly'
            ? t('supportedSubtitleFormats')
            : t('supportedMediaFormats')}
        </p>
      </div>
    );
  }

  return (
    <Table>
      <TableCaption>{t('taskList')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[500px]">{t('fileName')}</TableHead>
          {shouldShowAudioColumn && (
            <TableHead className="w-[100px]">{t('extractAudio')}</TableHead>
          )}
          {shouldShowSubtitleColumn && (
            <TableHead className="w-[100px]">{t('extractSubtitle')}</TableHead>
          )}
          {shouldShowTranslateColumn && (
            <TableHead className="w-[100px]">
              {t('translateSubtitle')}
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody className="max-h-[80vh]">
        {files.map((file) => (
          <TableRow key={file?.uuid}>
            <TableCell className="font-medium">{file?.filePath}</TableCell>
            {shouldShowAudioColumn && (
              <TableCell>
                <TaskStatus
                  file={file}
                  checkKey="extractAudio"
                  skip={isSubtitleFile(file?.filePath)}
                />
              </TableCell>
            )}
            {shouldShowSubtitleColumn && (
              <TableCell>
                <TaskStatus
                  file={file}
                  checkKey="extractSubtitle"
                  skip={isSubtitleFile(file?.filePath)}
                />
              </TableCell>
            )}
            {shouldShowTranslateColumn && (
              <TableCell>
                <TaskStatus
                  file={file}
                  checkKey="translateSubtitle"
                  skip={formData.translateProvider === '-1'}
                />
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};
export default TaskList;
