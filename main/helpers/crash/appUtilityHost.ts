/**
 * 应用内使用的 utilityProcess 宿主：把应用日志与崩溃记录接到底座上。
 * 底座（utilityHost.ts）本身不引用 storeManager，保持可单测；这里负责接线。
 */
import { logMessage } from '../storeManager';
import { expectUtilityKill, recordUtilityExit } from './crashReporting';
import {
  spawnUtilityHost,
  type SpawnHostOptions,
  type UtilityHost,
} from './utilityHost';

export function spawnAppUtilityHost(
  options: Pick<
    SpawnHostOptions,
    'workerFile' | 'serviceName' | 'logLabel' | 'env'
  >,
): UtilityHost {
  return spawnUtilityHost({
    ...options,
    log: logMessage,
    recordExit: recordUtilityExit,
    expectKill: expectUtilityKill,
  });
}
