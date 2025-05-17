import React, { useEffect, useState } from 'react';
import { cn } from 'lib/utils';

import { ScrollArea } from '@/components/ui/scroll-area';

import useSystemInfo from 'hooks/useStystemInfo';
import useFormConfig from 'hooks/useFormConfig';
import useIpcCommunication from 'hooks/useIpcCommunication';
import TaskControls from '@/components/TaskControls';
import TaskList from '@/components/TaskList';
import TaskConfigForm from '@/components/TaskConfigForm';
import TaskListControl from '@/components/TaskListControl';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';
import { filterSupportedFiles } from 'lib/utils';
import type { IFiles } from '../../../types';

export default function Component() {
  const [files, setFiles] = useState<IFiles[]>([]);
  const { systemInfo } = useSystemInfo();
  const { form, formData } = useFormConfig();
  useIpcCommunication(setFiles);

  useEffect(() => {
    const loadTasks = async () => {
      const tasks = await window.ipc.invoke('getTasks');
      setFiles(tasks);
    };
    loadTasks();
  }, []);

  useEffect(() => {
    window.ipc.send('setTasks', files);
  }, [files]);

  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    // 获取所有拖放的项目（文件和文件夹）
    const items = e.dataTransfer.items;
    const paths: string[] = [];

    if (items) {
      // 使用DataTransferItemList接口获取所有文件和文件夹
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        // 如果是文件系统条目
        if (item.kind === 'file') {
          const fileSystemEntry = item.webkitGetAsEntry();
          // 将文件或文件夹的路径添加到列表中
          if (fileSystemEntry) {
            // @ts-ignore - 获取文件路径，这是Electron特有的属性
            const path = item.getAsFile()?.path;
            if (path) {
              paths.push(path);
            }
          }
        }
      }
    } else {
      // 回退到标准File API（不支持WebkitGetAsEntry的情况）
      const files = e.dataTransfer.files;
      for (let i = 0; i < files.length; i++) {
        // @ts-ignore - 获取文件路径，这是Electron特有的属性
        const path = files[i].path;
        if (path) {
          paths.push(path);
        }
      }
    }

    if (paths.length > 0) {
      // 根据translateOnly任务类型决定是否只处理字幕文件
      const isTranslateOnly = formData.taskType === 'translateOnly';
      const taskType = isTranslateOnly ? 'translate' : 'media';

      window?.ipc
        ?.invoke('getDroppedFiles', {
          files: paths,
          taskType,
        })
        .then((files) => {
          setFiles((prevFiles) => [...prevFiles, ...files]);
        });
    }
  };

  return (
    <div className="grid flex-1 gap-4 overflow-auto p-4 md:grid-cols-2 lg:grid-cols-3">
      <div className="relative hidden flex-col items-start gap-8 md:flex">
        <TaskConfigForm
          form={form}
          formData={formData}
          systemInfo={systemInfo}
        />
      </div>
      <div
        className={cn(
          'relative flex h-full min-h-[50vh] border flex-col rounded-xl p-4 lg:col-span-2',
          isDragging && 'border-2 border-dashed border-primary bg-muted/50',
        )}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <TaskListControl setFiles={setFiles} formData={formData} />
        <ScrollArea className="max-h-[780px] min-h-[780px] mt-4">
          <TaskList files={files} formData={formData} />
        </ScrollArea>
        <div className="flex-1" />
        <TaskControls formData={formData} files={files} setFiles={setFiles} />
      </div>
      {/* <Guide systemInfo={systemInfo} updateSystemInfo={updateSystemInfo} /> */}
    </div>
  );
}

export const getStaticProps = makeStaticProperties(['common', 'home']);

export { getStaticPaths };
