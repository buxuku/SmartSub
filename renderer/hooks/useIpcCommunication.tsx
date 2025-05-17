import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { IFiles } from '../../types';

export default function useIpcCommunication(
  setFiles: Dispatch<SetStateAction<IFiles[]>>,
) {
  useEffect(() => {
    window?.ipc?.on('file-selected', (res: IFiles[]) => {
      setFiles((prevFiles) => [...prevFiles, ...res]);
    });

    const handleTaskStatusChange = (
      res: IFiles,
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
      res: IFiles,
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
      res: IFiles,
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

    const handleFileChange = (res: IFiles) => {
      setFiles((prevFiles) => {
        const updatedFiles = prevFiles.map((file) =>
          file.uuid === res?.uuid ? { ...file, ...res } : file,
        );
        return updatedFiles;
      });
    };

    window?.ipc?.on('taskStatusChange', handleTaskStatusChange);
    window?.ipc?.on('taskProgressChange', handleTaskProgressChange);
    window?.ipc?.on('taskErrorChange', handleTaskErrorChange);
    window?.ipc?.on('taskFileChange', handleFileChange);
    return () => {};
  }, []);
}
