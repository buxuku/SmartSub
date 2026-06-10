/**
 * Python 引擎在 Electron 环境下的接线:命令解析 + 单例管理。
 *
 * 运行时解析优先级:
 *  1. 环境变量 PYTHON_ENGINE_CMD(如 "/usr/bin/python3 /abs/path/main.py",调试用)
 *  2. 打包环境:userData/py-engine/current/ 下的冻结产物(由后续"运行时按需下载"安装)
 *  3. 开发环境:系统 python3 + 仓库内 python-engine/main.py
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
    // 正式形态:运行时包安装到 userData(PoC 阶段尚未实现下载安装)
    const binName =
      process.platform === 'win32' ? 'smartsub-engine.exe' : 'smartsub-engine';
    return {
      command: path.join(
        app.getPath('userData'),
        'py-engine',
        'current',
        binName,
      ),
      args: [],
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
