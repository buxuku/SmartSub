/**
 * Python 引擎在 Electron 环境下的接线:命令解析 + 单例管理。
 *
 * 运行时解析优先级:
 *  1. 环境变量 PYTHON_ENGINE_CMD(如 "/usr/bin/python3 /abs/path/main.py",调试用)
 *  2. 打包环境:resources/extraResources/py-engine/ 随包分发的冻结产物;
 *     不存在时回退 userData/py-engine/current/(预留给"运行时按需下载"形态)
 *  3. 开发环境:python-engine/.venv 或系统 python3 + 仓库内 main.py
 */
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { logMessage } from '../storeManager';
import { PythonEngineManager, EngineCommand } from './manager';

export * from './protocol';
export { PythonEngineManager, PythonEngineError } from './manager';

function resolveEngineCommand(): EngineCommand {
  const override = process.env.PYTHON_ENGINE_CMD;
  if (override) {
    const parts = override.split(' ').filter(Boolean);
    return { command: parts[0], args: parts.slice(1) };
  }

  if (app.isPackaged) {
    const binName =
      process.platform === 'win32' ? 'smartsub-engine.exe' : 'smartsub-engine';
    // 路径与 extraResources/addons 的分发约定保持一致
    const bundled = path.join(
      process.resourcesPath,
      'extraResources',
      'py-engine',
      binName,
    );
    // 未随包分发时,回退到运行时安装目录(后续可实现按需下载)
    const runtimeInstalled = path.join(
      app.getPath('userData'),
      'py-engine',
      'current',
      binName,
    );
    const command = fs.existsSync(bundled) ? bundled : runtimeInstalled;
    return {
      command,
      args: [],
      cwd: path.dirname(command),
      env: {
        // 模型缓存收敛到 userData,避免散落在 ~/.cache/huggingface
        HF_HOME: path.join(app.getPath('userData'), 'py-engine-cache'),
      },
    };
  }

  // 开发环境:优先使用 python-engine/.venv(装有 faster-whisper),
  // 否则回退系统 python(fake 引擎仅需标准库,仍可验证链路)
  const engineDir = path.join(app.getAppPath(), 'python-engine');
  const venvPython =
    process.platform === 'win32'
      ? path.join(engineDir, '.venv', 'Scripts', 'python.exe')
      : path.join(engineDir, '.venv', 'bin', 'python');
  const fallbackPython = process.platform === 'win32' ? 'python' : 'python3';
  return {
    command: fs.existsSync(venvPython) ? venvPython : fallbackPython,
    args: [path.join(engineDir, 'main.py')],
    cwd: engineDir,
  };
}

let manager: PythonEngineManager | null = null;

export function getPythonEngineManager(): PythonEngineManager {
  if (!manager) {
    manager = new PythonEngineManager(resolveEngineCommand, (message, level) =>
      logMessage(message, level),
    );
  }
  return manager;
}

export async function shutdownPythonEngine(): Promise<void> {
  if (manager) {
    await manager.stop();
  }
}
