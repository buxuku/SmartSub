import React, { useState } from 'react';
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
import { Upload, FileUp, Edit2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import dynamic from 'next/dynamic';

// 动态导入SubtitleProofread组件，避免服务端渲染问题
const SubtitleProofread = dynamic(
  () => import('@/components/SubtitleProofread'),
  {
    ssr: false,
    loading: () => <div>Loading...</div>,
  },
);

interface TaskListProps {
  files: any[];
  formData: any;
}

const TaskList: React.FC<TaskListProps> = ({ files = [], formData }) => {
  const { t } = useTranslation('home');
  const { taskType } = formData;
  const [proofreadOpen, setProofreadOpen] = useState(false);
  const [currentFile, setCurrentFile] = useState(null);

  // 根据任务类型确定要显示的列
  const shouldShowAudioColumn = taskType !== 'translateOnly';
  const shouldShowSubtitleColumn = taskType !== 'translateOnly';
  const shouldShowTranslateColumn = taskType !== 'generateOnly';

  const handleImport = async () => {
    const fileType = taskType === 'translateOnly' ? 'srt' : 'media';
    window?.ipc?.send('openDialog', { dialogType: 'openDialog', fileType });
  };

  const handleProofread = (file) => {
    setCurrentFile(file);
    setProofreadOpen(true);
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
    <>
      <Table>
        <TableCaption>{t('taskList')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[500px]">{t('fileName')}</TableHead>
            {shouldShowAudioColumn && (
              <TableHead className="w-[100px]">{t('extractAudio')}</TableHead>
            )}
            {shouldShowSubtitleColumn && (
              <TableHead className="w-[100px]">
                {t('extractSubtitle')}
              </TableHead>
            )}
            {shouldShowTranslateColumn && (
              <TableHead className="w-[100px]">
                {t('translateSubtitle')}
              </TableHead>
            )}
            <TableHead className="w-[100px]">
              {t('proofread') || '校对'}
            </TableHead>
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
              <TableCell>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex items-center gap-1"
                  onClick={() => handleProofread(file)}
                  // disabled={!(file?.status?.extractSubtitle?.done && file?.status?.translateSubtitle?.done)}
                >
                  <Edit2 className="h-4 w-4" />
                  {t('proofread') || '校对'}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {proofreadOpen && (
        <SubtitleProofread
          file={currentFile}
          open={proofreadOpen}
          onOpenChange={setProofreadOpen}
        />
      )}
    </>
  );
};
export default TaskList;
