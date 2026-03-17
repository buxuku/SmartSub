import React, { useEffect, useState, useMemo } from 'react';
import { cn, isSubtitleFile } from 'lib/utils';

import { ScrollArea } from '@/components/ui/scroll-area';

import useSystemInfo from 'hooks/useStystemInfo';
import useFormConfig from 'hooks/useFormConfig';
import useIpcCommunication from 'hooks/useIpcCommunication';
import TaskControls from '@/components/TaskControls';
import TaskList from '@/components/TaskList';
import TaskConfigForm from '@/components/TaskConfigForm';
import TaskListControl from '@/components/TaskListControl';
import { ProofreadEditor } from '@/components/proofread';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';
import { filterSupportedFiles } from 'lib/utils';
import { IFiles } from '../../../types';
import path from 'path';

export default function Component() {
  const [files, setFiles] = useState([]);
  const [proofreadFile, setProofreadFile] = useState<IFiles | null>(null);
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

    const paths: string[] = [];
    const droppedFiles = e.dataTransfer.files;
    for (let i = 0; i < droppedFiles.length; i++) {
      // @ts-ignore - Electron File 对象包含 path 属性，支持文件和文件夹
      const filePath = droppedFiles[i].path;
      if (filePath) {
        paths.push(filePath);
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

  // 将 IFiles 转换为 ProofreadEditor 需要的 PendingFile 格式
  const pendingFileForProofread = useMemo(() => {
    if (!proofreadFile) return null;

    const { taskType } = formData;
    const isTranslateOnly = taskType === 'translateOnly';
    const isGenerateOnly = taskType === 'generateOnly';

    // 确定视频路径
    const videoPath = isSubtitleFile(proofreadFile.filePath)
      ? undefined
      : proofreadFile.filePath;

    // 确定源字幕路径 - 优先使用目标目录的文件
    const sourceSubtitlePath =
      proofreadFile.srtFile ||
      proofreadFile.tempSrtFile ||
      (isSubtitleFile(proofreadFile.filePath)
        ? proofreadFile.filePath
        : path.join(proofreadFile.directory, `${proofreadFile.fileName}.srt`));

    // 确定翻译字幕路径（仅在需要翻译时）- 优先使用临时目录的纯翻译文件
    const targetSubtitlePath = isGenerateOnly
      ? undefined
      : proofreadFile.tempTranslatedSrtFile || proofreadFile.translatedSrtFile;

    // 目标翻译文件路径（用户配置格式，可能是双语）
    const finalTargetPath = isGenerateOnly
      ? undefined
      : proofreadFile.translatedSrtFile;

    return {
      id: proofreadFile.uuid,
      videoPath,
      fileName: proofreadFile.fileName,
      selectedSource: sourceSubtitlePath,
      selectedTarget: targetSubtitlePath,
      sourceLanguage: formData.sourceLanguage,
      targetLanguage: formData.targetLanguage,
      status: 'proofreading' as const,
      finalTargetPath,
      translateContent: formData.translateContent,
    };
  }, [proofreadFile, formData]);

  // 如果正在校对，显示校对编辑器
  if (proofreadFile && pendingFileForProofread) {
    return (
      <div className="h-full p-4">
        <ProofreadEditor
          file={pendingFileForProofread}
          onMarkComplete={() => setProofreadFile(null)}
          onBack={() => setProofreadFile(null)}
        />
      </div>
    );
  }

  return (
    <div className="grid h-full gap-4 p-4 md:grid-cols-2 lg:grid-cols-3 overflow-hidden">
      <div className="relative hidden h-full flex-col items-start gap-4 md:flex overflow-auto">
        <TaskConfigForm
          form={form}
          formData={formData}
          systemInfo={systemInfo}
        />
      </div>
      <div
        className={cn(
          'relative flex h-full border flex-col rounded-xl p-4 lg:col-span-2 overflow-hidden',
          isDragging && 'border-2 border-dashed border-primary bg-muted/50',
        )}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <TaskListControl
          setFiles={setFiles}
          formData={formData}
          className="flex-shrink-0"
        />
        <ScrollArea className="flex-1 min-h-0 mt-4">
          <TaskList
            files={files}
            formData={formData}
            onProofread={(file) => setProofreadFile(file)}
            onDelete={(uuid) =>
              setFiles((prev) => prev.filter((f) => f.uuid !== uuid))
            }
          />
        </ScrollArea>
        <TaskControls
          formData={formData}
          files={files}
          className="mt-auto flex-shrink-0 pt-4"
        />
      </div>
      {/* <Guide systemInfo={systemInfo} updateSystemInfo={updateSystemInfo} /> */}
    </div>
  );
}

export const getStaticProps = makeStaticProperties(['common', 'home']);

export { getStaticPaths };
