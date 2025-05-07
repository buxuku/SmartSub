import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { ITaskFile } from '../../types';

export default function useIpcCommunication(
  setFiles: Dispatch<SetStateAction<ITaskFile[]>>,
) {
  useEffect(() => {
    window?.ipc?.on('file-selected', (res: string[]) => {
      setFiles((prevFiles) => [
        ...prevFiles,
        ...res.map((file) => ({
          uuid: Math.random().toString(36).substring(2),
          filePath: file,
        })),
      ]);
    });

    const handleTaskStatusChange = (
      res: ITaskFile,
      key: string,
      status: string,
    ) => {
      setFiles((prevFiles) => {
        const updatedFiles = prevFiles.map((file) =>
          file.uuid === res?.uuid ? { ...file, [key]: status } : file,
        );
        return updatedFiles;
      });
    };

    const handleTaskProgressChange = (
      res: ITaskFile,
      key: string,
      progress: number,
    ) => {
      setFiles((prevFiles) => {
        const progressKey = `${key}Progress`;
        const updatedFiles = prevFiles.map((file) =>
          file.uuid === res?.uuid ? { ...file, [progressKey]: progress } : file,
        );
        return updatedFiles;
      });
    };

    const handleTaskErrorChange = (
      res: ITaskFile,
      key: string,
      errorMsg: string,
    ) => {
      setFiles((prevFiles) => {
        const errorKey = `${key}Error`;
        const updatedFiles = prevFiles.map((file) =>
          file.uuid === res?.uuid ? { ...file, [errorKey]: errorMsg } : file,
        );
        return updatedFiles;
      });
    };

    window?.ipc?.on('taskStatusChange', handleTaskStatusChange);
    window?.ipc?.on('taskProgressChange', handleTaskProgressChange);
    window?.ipc?.on('taskErrorChange', handleTaskErrorChange);

    return () => {};
  }, []);
}
