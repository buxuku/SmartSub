import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { logMessage } from '../storeManager';
import { PythonRuntimeManager, type EngineCommand } from './manager';
import {
  getPyEngineBinaryPath,
  getPyEngineCacheDir,
  getPyEngineCurrentDir,
  isPyEngineInstalled,
} from './paths';

export * from './protocol';
export { PythonRuntimeManager, PythonEngineError } from './manager';

function resolveEngineCommand(): EngineCommand {
  const override = process.env.PYTHON_ENGINE_CMD;
  if (override) {
    const parts = override.split(' ').filter(Boolean);
    return { command: parts[0], args: parts.slice(1) };
  }

  if (app.isPackaged) {
    if (!isPyEngineInstalled()) {
      throw new Error('Python engine is not installed');
    }
    const command = getPyEngineBinaryPath();
    return {
      command,
      args: [],
      cwd: getPyEngineCurrentDir(),
      env: { HF_HOME: getPyEngineCacheDir() },
    };
  }

  const engineDir = path.join(app.getAppPath(), 'python-engine');
  const venvPython =
    process.platform === 'win32'
      ? path.join(engineDir, '.venv', 'Scripts', 'python.exe')
      : path.join(engineDir, '.venv', 'bin', 'python');
  const fallback = process.platform === 'win32' ? 'python' : 'python3';
  return {
    command: fs.existsSync(venvPython) ? venvPython : fallback,
    args: [path.join(engineDir, 'main.py')],
    cwd: engineDir,
    env: { HF_HOME: getPyEngineCacheDir() },
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
  if (manager) await manager.stop();
}
