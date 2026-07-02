import { useEffect, useState } from 'react';
import { ISystemInfo } from '../../types/types';

export default function useSystemInfo() {
  const [systemInfo, setSystemInfo] = useState<ISystemInfo>({
    modelsInstalled: [],
    modelsPath: '',
    downloadingModels: [],
  });
  /** 首次 getSystemInfo 是否已返回：消费方据此区分「尚未加载」与「确实没装模型」 */
  const [loaded, setLoaded] = useState(false);

  const updateSystemInfo = async () => {
    const systemInfoRes = await window?.ipc?.invoke('getSystemInfo', null);
    setSystemInfo(systemInfoRes);
  };

  useEffect(() => {
    updateSystemInfo()
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  return { systemInfo, updateSystemInfo, loaded };
}
