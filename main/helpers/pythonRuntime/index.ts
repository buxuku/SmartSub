import path from 'path';
import { logMessage } from '../storeManager';
import { getFasterWhisperModelsPath } from '../modelCatalog';
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

export * from './protocol';
export { PythonRuntimeManager, PythonEngineError } from './manager';

const NOT_READY_MSG =
  'Python engine not ready. Ensure the base runtime is bundled and the engine package is downloaded (Resource Hub > Engines), or set PYTHON_ENGINE_CMD for local development.';

function resolveEngineCommand(): EngineCommand {
  const override = process.env.PYTHON_ENGINE_CMD;
  if (override) {
    const parts = override.split(' ').filter(Boolean);
    return { command: parts[0], args: parts.slice(1) };
  }

  if (!isPyBaseReady() || !isEnginePackageInstalled('faster-whisper')) {
    throw new Error(NOT_READY_MSG);
  }

  // 三层组合：基座 python 跑引擎包 main.py，PYTHONPATH 挂当前引擎 site-packages
  const baseDir = resolvePyBaseDir();
  const modelsPath = getFasterWhisperModelsPath();
  return {
    command: getPyBasePythonPath(baseDir),
    args: [getEngineMainPy('faster-whisper')],
    cwd: getEngineDir('faster-whisper'),
    pythonHome: baseDir,
    pythonPath: getEngineSitePackages('faster-whisper'),
    env: {
      HF_HOME: modelsPath,
      HF_HUB_CACHE: path.join(modelsPath, 'hub'),
    },
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
