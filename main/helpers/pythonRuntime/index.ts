import path from 'path';
import { logMessage } from '../storeManager';
import { getFasterWhisperModelsPath } from '../modelCatalog';
import { getFunasrModelsRoot } from '../funasrModelCatalog';
import { PythonRuntimeManager, type EngineCommand } from './manager';
import {
  resolvePyBaseDir,
  getPyBasePythonPath,
  isPyBaseReady,
  getEngineDir,
  getEngineMainPy,
  getEngineSitePackages,
  isEnginePackageInstalled,
} from './paths';
import type { PyEngineId } from '../../../types/engine';

export * from './protocol';
export { PythonRuntimeManager, PythonEngineError } from './manager';

const NOT_READY_MSG =
  'Python engine not ready. Ensure the base runtime is bundled and the engine package is downloaded (Resource Hub > Engines), or set PYTHON_ENGINE_CMD for local development.';

/** 按引擎给出模型缓存环境：faster-whisper 用 HF cache；funasr 用本地 onnx 目录隔离缓存。 */
function resolveEngineEnv(engineId: PyEngineId): Record<string, string> {
  if (engineId === 'faster-whisper') {
    const modelsPath = getFasterWhisperModelsPath();
    return {
      HF_HOME: modelsPath,
      HF_HUB_CACHE: path.join(modelsPath, 'hub'),
    };
  }
  // funasr：模型由 App 下载到本地 onnx 文件并经 params 传入，不依赖 HF 下载，
  // 仍设隔离缓存目录，避免落到全局 ~/.cache。
  const funasrRoot = getFunasrModelsRoot();
  return {
    HF_HOME: funasrRoot,
    MODELSCOPE_CACHE: path.join(funasrRoot, '.modelscope'),
  };
}

function resolveEngineCommand(engineId: PyEngineId): EngineCommand {
  const override = process.env.PYTHON_ENGINE_CMD;
  if (override) {
    const parts = override.split(' ').filter(Boolean);
    return { command: parts[0], args: parts.slice(1) };
  }

  if (!isPyBaseReady() || !isEnginePackageInstalled(engineId)) {
    throw new Error(NOT_READY_MSG);
  }

  // 三层组合：基座 python 跑引擎包 main.py，PYTHONPATH 挂当前引擎 site-packages
  const baseDir = resolvePyBaseDir();
  return {
    command: getPyBasePythonPath(baseDir),
    args: [getEngineMainPy(engineId)],
    cwd: getEngineDir(engineId),
    pythonHome: baseDir,
    pythonPath: getEngineSitePackages(engineId),
    env: resolveEngineEnv(engineId),
  };
}

let manager: PythonRuntimeManager | null = null;

export function getPythonRuntimeManager(): PythonRuntimeManager {
  if (!manager) {
    manager = new PythonRuntimeManager(resolveEngineCommand, (msg, level) =>
      logMessage(msg, level),
    );
  }
  return manager;
}

export async function shutdownPythonRuntime(): Promise<void> {
  if (manager) {
    await manager.stop();
    manager = null;
  }
}
