import path from 'path';
import { logMessage } from '../storeManager';
import { getFasterWhisperModelsPath } from '../modelCatalog';
import { PythonRuntimeManager, type EngineCommand } from './manager';
import {
  getPyEngineBinaryPath,
  getPyEngineCurrentDir,
  isPyEngineInstalled,
  normalizePyEngineLayout,
} from './paths';

export * from './protocol';
export { PythonRuntimeManager, PythonEngineError } from './manager';

const NOT_INSTALLED_MSG =
  'Python engine is not installed. Download it from Resource Hub > Engines, or set PYTHON_ENGINE_CMD for local development.';

function resolveEngineCommand(): EngineCommand {
  const override = process.env.PYTHON_ENGINE_CMD;
  if (override) {
    const parts = override.split(' ').filter(Boolean);
    return { command: parts[0], args: parts.slice(1) };
  }

  if (!isPyEngineInstalled()) {
    throw new Error(NOT_INSTALLED_MSG);
  }

  normalizePyEngineLayout();

  const command = getPyEngineBinaryPath();
  const modelsPath = getFasterWhisperModelsPath();
  return {
    command,
    args: [],
    cwd: getPyEngineCurrentDir(),
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
