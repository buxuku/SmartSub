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
import { FileUp, Edit2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { IFiles } from '../../types';

// 从完整路径中提取文件名
const getFileName = (filePath: string): string => {
  if (!filePath) return '';
  // 支持 Windows 和 Unix 路径分隔符
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
};

interface TaskListProps {
  files: any[];
  formData: any;
  onProofread?: (file: IFiles) => void;
}

const TaskList: React.FC<TaskListProps> = ({
  files = [],
  formData,
  onProofread,
}) => {
  const { t } = useTranslation('home');
  const { taskType } = formData;

  // 根据任务类型确定要显示的列
  const shouldShowAudioColumn = taskType !== 'translateOnly';
  const shouldShowSubtitleColumn = taskType !== 'translateOnly';
  const shouldShowTranslateColumn = taskType !== 'generateOnly';

  // 判断校对按钮是否禁用
  const isProofreadDisabled = (file) => {
    if (taskType === 'generateOnly') {
      return !(file?.extractSubtitle === 'done');
    } else {
      return !(file?.translateSubtitle === 'done');
    }
  };

  const handleImport = async () => {
    const fileType = taskType === 'translateOnly' ? 'srt' : 'media';
    window?.ipc?.send('openDialog', { dialogType: 'openDialog', fileType });
  };

  const handleProofread = (file: IFiles) => {
    if (onProofread) {
      onProofread(file);
    }
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
      <Table className="table-fixed w-full">
        <TableCaption>{t('taskList')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead className="w-auto">{t('fileName')}</TableHead>
            {shouldShowAudioColumn && (
              <TableHead className="w-[90px] text-center">
                {t('extractAudio')}
              </TableHead>
            )}
            {shouldShowSubtitleColumn && (
              <TableHead className="w-[90px] text-center">
                {t('extractSubtitle')}
              </TableHead>
            )}
            {shouldShowTranslateColumn && (
              <TableHead className="w-[90px] text-center">
                {t('translateSubtitle')}
              </TableHead>
            )}
            <TableHead className="w-[80px] text-center">
              {t('proofread') || '校对'}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {files.map((file) => (
            <TableRow key={file?.uuid}>
              <TableCell className="font-medium truncate max-w-0">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-default truncate block">
                        {getFileName(file?.filePath)}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-md">
                      <p className="break-all">{file?.filePath}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </TableCell>
              {shouldShowAudioColumn && (
                <TableCell className="text-center">
                  <TaskStatus
                    file={file}
                    checkKey="extractAudio"
                    skip={isSubtitleFile(file?.filePath)}
                  />
                </TableCell>
              )}
              {shouldShowSubtitleColumn && (
                <TableCell className="text-center">
                  <TaskStatus
                    file={file}
                    checkKey="extractSubtitle"
                    skip={isSubtitleFile(file?.filePath)}
                  />
                </TableCell>
              )}
              {shouldShowTranslateColumn && (
                <TableCell className="text-center">
                  <TaskStatus
                    file={file}
                    checkKey="translateSubtitle"
                    skip={formData.translateProvider === '-1'}
                  />
                </TableCell>
              )}
              <TableCell className="text-center">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex items-center gap-1 mx-auto"
                  onClick={() => handleProofread(file)}
                  disabled={isProofreadDisabled(file)}
                >
                  <Edit2 className="h-3 w-3" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
};
export default TaskList;
