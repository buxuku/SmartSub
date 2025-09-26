import { useEffect } from 'react';
import { IFiles } from '../../types';

export default function useIpcCommunication(setFiles) {
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
      // 验证进度值的合理性
      const normalizedProgress = Math.min(Math.max(progress || 0, 0), 100);

      setFiles((prevFiles) => {
        const progressKey = `${key}Progress`;
        const updatedFiles = prevFiles.map((file) => {
          if (file.uuid === res?.uuid) {
            const currentProgress = file[progressKey] || 0;

            // 防止进度回退，除非是重新开始（进度为0）
            if (
              normalizedProgress === 0 ||
              normalizedProgress >= currentProgress
            ) {
              return { ...file, [progressKey]: normalizedProgress };
            }

            // 如果进度回退了，记录警告但仍然更新（可能是重试）
            console.warn(
              `Progress rollback detected for ${key}: ${currentProgress} -> ${normalizedProgress}`,
            );
            return { ...file, [progressKey]: normalizedProgress };
          }
          return file;
        });
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
        const updatedFiles = prevFiles.map((file) => {
          if (file.uuid === res?.uuid) {
            const updatedFile = { ...file, ...res };

            // 状态一致性检查：如果状态变为 'done'，确保进度为100%
            Object.keys(res).forEach((key) => {
              if (key.endsWith('Subtitle') && res[key] === 'done') {
                const progressKey = `${key}Progress`;
                if (
                  !updatedFile[progressKey] ||
                  updatedFile[progressKey] < 100
                ) {
                  updatedFile[progressKey] = 100;
                }
              }

              // 如果状态变为 'error'，保持当前进度不变
              if (key.endsWith('Subtitle') && res[key] === 'error') {
                const progressKey = `${key}Progress`;
                // 保持原有进度，不重置
              }

              // 如果状态变为 'loading'，确保有初始进度
              if (key.endsWith('Subtitle') && res[key] === 'loading') {
                const progressKey = `${key}Progress`;
                if (!updatedFile[progressKey]) {
                  updatedFile[progressKey] = 0;
                }
              }
            });

            return updatedFile;
          }
          return file;
        });
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
