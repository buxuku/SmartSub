import { useEffect, useState } from 'react';
import { ISystemInfo } from '../../types/types';

export default function useSystemInfo() {
  const [systemInfo, setSystemInfo] = useState<ISystemInfo>({
    modelsInstalled: [],
    modelsPath: '',
    downloadingModels: [],
  });

  const updateSystemInfo = async () => {
    const systemInfoRes = await window?.ipc?.invoke('getSystemInfo', null);
    setSystemInfo(systemInfoRes);
  };

  useEffect(() => {
    updateSystemInfo();
  }, []);

  return { systemInfo, updateSystemInfo };
}
