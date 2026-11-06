/**
 * CPU 指令集探测的 Electron 适配层：把 app 的信息（是否转译、userData 目录）接到真实依赖上。
 *
 * 一次运行只探测一次（结果缓存在内存里）；Windows 上还把结果按 CPU 型号 + 系统版本
 * 落盘到 userData/cpu-features.json，之后启动不必再起 PowerShell。
 */
import path from 'path';
import { app } from 'electron';
import type { CpuAdvisory, CpuFeatureReport } from '../../../types/cpuAdvisory';
import { detectCpuFeatures, toAdvisory, unknownFeatures } from './cpuFeatures';
import { createNodeProbeDeps } from './cpuFeaturesNode';

let reportPromise: Promise<CpuFeatureReport> | null = null;

/** 完整探测结果（诊断包与日志用）。从不抛错，也不会长时间挂起（外部命令有超时）。 */
export function getCpuFeatureReport(): Promise<CpuFeatureReport> {
  if (!reportPromise) {
    reportPromise = Promise.resolve()
      .then(() =>
        detectCpuFeatures(
          createNodeProbeDeps({
            translated: app.runningUnderARM64Translation === true,
            cacheFile: path.join(app.getPath('userData'), 'cpu-features.json'),
          }),
        ),
      )
      .catch(
        (): CpuFeatureReport => ({
          applicable: true,
          translated: false,
          source: 'unavailable',
          cpuModel: null,
          features: unknownFeatures(),
          note: 'cpu feature detection failed unexpectedly',
        }),
      );
  }
  return reportPromise;
}

/** 给界面的结论：只有明确缺失的指令集才会出现在 missing 里。 */
export async function getCpuAdvisory(): Promise<CpuAdvisory> {
  return toAdvisory(await getCpuFeatureReport(), process.platform);
}
