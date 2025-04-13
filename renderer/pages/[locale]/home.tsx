import React, { useEffect, useState } from 'react';
import { cn } from "lib/utils";

import { ScrollArea } from '@/components/ui/scroll-area';


import useSystemInfo from 'hooks/useStystemInfo';
import useFormConfig from 'hooks/useFormConfig';
import useIpcCommunication from 'hooks/useIpcCommunication';
import TaskControls from '@/components/TaskControls';
import TaskList from '@/components/TaskList';
import TaskConfigForm from '@/components/TaskConfigForm';
import TaskListControl from '@/components/TaskListControl';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static'
import { filterSupportedFiles } from 'lib/utils';



export default function Component() {
  const [files, setFiles] = useState([]);
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
    
    const droppedFiles = filterSupportedFiles(Array.from(e.dataTransfer.files));
    
    if (droppedFiles.length > 0) {
      const fileList = droppedFiles.map(file => file.path);
      window?.ipc?.invoke('getDroppedFiles', fileList).then((filePaths) => {
        const newFiles = filePaths.map(filePath => ({
          uuid: Math.random().toString(36).substring(2),
          filePath
        }));
        setFiles(prevFiles => [...prevFiles, ...newFiles]);
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
          "relative flex h-full min-h-[50vh] border flex-col rounded-xl p-4 lg:col-span-2",
          isDragging && "border-2 border-dashed border-primary bg-muted/50"
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
        <TaskControls formData={formData} files={files} />
      </div>
      {/* <Guide systemInfo={systemInfo} updateSystemInfo={updateSystemInfo} /> */}
    </div>
  );
}

export const getStaticProps = makeStaticProperties(['common', 'home'])

export { getStaticPaths }