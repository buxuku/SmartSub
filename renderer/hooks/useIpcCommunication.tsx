import { useCallback, useEffect, useRef } from 'react';
import { IFiles } from '../../types';

export default function useIpcCommunication(
  setFiles,
  appendFiles?: (incoming: IFiles[]) => void,
) {
  // 始终调用最新的 appendFiles（含去重逻辑），避免事件订阅闭包过期
  const appendFilesRef = useRef(appendFiles);
  appendFilesRef.current = appendFiles;

  // 装载窗口事件缓存：向导「保存工程→派发任务→跳转任务页」后主进程立即开跑，
  // 秒级完成的阶段事件（如音频缓存命中时提取阶段瞬时 loading→done）可能在
  // 工程文件尚未加载进 state 时到达——此时按 uuid 找不到文件会被丢弃，且随后
  // 的 files 持久化回写会把主进程镜像里的正确状态覆盖掉（进度永远缺一段）。
  // 这里将找不到文件的事件按 uuid 暂存为补丁，hydrateFiles 加载时合并回放。
  const pendingEventsRef = useRef<Map<string, Record<string, any>>>(new Map());

  useEffect(() => {
    // 注意：stash 在 setFiles 更新器内调用（需要 prevFiles 判断是否命中），
    // 补丁按 key 覆盖合并，同一事件重放（StrictMode 双调用）幂等。
    const stashPendingEvent = (
      uuid: string | undefined,
      patch: Record<string, any>,
    ) => {
      if (!uuid) return;
      const prev = pendingEventsRef.current.get(uuid) || {};
      pendingEventsRef.current.set(uuid, { ...prev, ...patch });
    };

    const cleanupFileSelected = window?.ipc?.on(
      'file-selected',
      (res: IFiles[]) => {
        if (appendFilesRef.current) {
          appendFilesRef.current(res);
        } else {
          setFiles((prevFiles) => [...prevFiles, ...res]);
        }
      },
    );

    const handleTaskStatusChange = (
      res: IFiles,
      key: string,
      status: string,
    ) => {
      setFiles((prevFiles) => {
        let matched = false;
        const updatedFiles = prevFiles.map((file) => {
          if (file.uuid !== res?.uuid) return file;
          matched = true;
          return { ...file, [key]: status };
        });
        if (!matched) {
          stashPendingEvent(res?.uuid, { [key]: status });
          return prevFiles;
        }
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
        let matched = false;
        const updatedFiles = prevFiles.map((file) => {
          if (file.uuid === res?.uuid) {
            matched = true;
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
        if (!matched) {
          stashPendingEvent(res?.uuid, { [progressKey]: normalizedProgress });
          return prevFiles;
        }
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
        let matched = false;
        const updatedFiles = prevFiles.map((file) => {
          if (file.uuid !== res?.uuid) return file;
          matched = true;
          return { ...file, [errorKey]: errorMsg };
        });
        if (!matched) {
          stashPendingEvent(res?.uuid, { [errorKey]: errorMsg });
          return prevFiles;
        }
        return updatedFiles;
      });
    };

    const handleFileChange = (res: IFiles) => {
      setFiles((prevFiles) => {
        let matched = false;
        const updatedFiles = prevFiles.map((file) => {
          if (file.uuid === res?.uuid) {
            matched = true;
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
        if (!matched) {
          stashPendingEvent(res?.uuid, { ...res });
          return prevFiles;
        }
        return updatedFiles;
      });
    };

    const cleanups = [
      cleanupFileSelected,
      window?.ipc?.on('taskStatusChange', handleTaskStatusChange),
      window?.ipc?.on('taskProgressChange', handleTaskProgressChange),
      window?.ipc?.on('taskErrorChange', handleTaskErrorChange),
      window?.ipc?.on('taskFileChange', handleFileChange),
    ];
    return () => {
      cleanups.forEach((cleanup) => cleanup?.());
    };
  }, []);

  /**
   * 用加载到的工程文件初始化 state，并合并装载窗口内暂存的任务事件补丁。
   * 返回实际写入 state 的数组（调用方可用它标记「来自加载」以跳过持久化回写）。
   */
  const hydrateFiles = useCallback(
    (loaded: IFiles[]): IFiles[] => {
      const pending = pendingEventsRef.current;
      pendingEventsRef.current = new Map();
      const merged = pending.size
        ? loaded.map((file) =>
            pending.has(file.uuid)
              ? { ...file, ...pending.get(file.uuid) }
              : file,
          )
        : loaded;
      setFiles(merged);
      return merged;
    },
    [setFiles],
  );

  return { hydrateFiles };
}
