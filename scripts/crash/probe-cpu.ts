/**
 * 真机上的 CPU 指令集探测检查（CI 里在 windows / linux / macos 的 runner 上各跑一次）。
 *
 * 单测里 Windows 的探测用的是假的 PowerShell 输出；这里用真实的 Node 依赖跑一遍，
 * 确认真实的 /proc/cpuinfo、PowerShell 的 IsProcessorFeaturePresent、sysctl 都给出可解析的结果，
 * 耗时在预期内，缓存生效。这是整个计划里风险最高的一项（Windows 的外部命令探测）唯一的真机验证。
 *
 * 用法：tsx scripts/crash/probe-cpu.ts
 * 退出码：0 通过；1 有断言失败。硬件本身缺指令集不算失败（只打印提示）：那是被检测对象，不是检测的缺陷。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectCpuFeatures,
  toAdvisory,
} from '../../main/helpers/crash/cpuFeatures';
import { createNodeProbeDeps } from '../../main/helpers/crash/cpuFeaturesNode';

/** Windows 上首次探测要起 PowerShell；超过这个耗时说明探测在拖慢启动后的后台任务 */
const WINDOWS_PROBE_BUDGET_MS = 12_000;
/** 命中缓存时不应再起外部进程 */
const CACHE_HIT_BUDGET_MS = 500;

const failures: string[] = [];
function expect(condition: unknown, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    failures.push(message);
    console.error(`  ✗ ${message}`);
  }
}

async function main() {
  const cacheDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'smartsub-cpu-probe-'),
  );
  const cacheFile = path.join(cacheDir, 'cpu-features-cache.json');
  const cpus = os.cpus();
  console.log(
    `CPU 探测真机检查 · ${process.platform}/${process.arch} · ${os.release()} · ${cpus[0]?.model?.trim()} x${cpus.length}`,
  );

  const started = Date.now();
  const report = await detectCpuFeatures(
    createNodeProbeDeps({ translated: false, cacheFile }),
  );
  const elapsed = Date.now() - started;
  console.log(`\n探测结果（${elapsed} ms）：`);
  console.log(JSON.stringify(report, null, 2));
  const advisory = toAdvisory(report, process.platform);
  console.log(`\n结论：${JSON.stringify(advisory)}`);

  const FEATURES = ['avx', 'avx2', 'fma', 'f16c', 'bmi2'] as const;
  console.log('\n断言：');

  if (process.arch !== 'x64') {
    expect(report.applicable === false, 'arm64：x86 指令集门槛不适用');
    expect(report.source === 'not-applicable', 'arm64：来源是 not-applicable');
    expect(advisory.missing.length === 0, 'arm64：不会给出缺失指令集的预警');
  } else if (process.platform === 'linux') {
    expect(report.source === 'proc-cpuinfo', 'Linux：来源是 /proc/cpuinfo');
    expect(
      FEATURES.every((f) => typeof report.features[f] === 'boolean'),
      'Linux：五项指令集都有明确的结果（没有 unknown）',
    );
  } else if (process.platform === 'win32') {
    expect(
      report.source === 'win32-ipf',
      'Windows：来源是 IsProcessorFeaturePresent',
    );
    expect(
      typeof report.features.avx === 'boolean' &&
        typeof report.features.avx2 === 'boolean',
      'Windows：AVX / AVX2 有明确的结果',
    );
    expect(
      report.features.fma === null &&
        report.features.f16c === null &&
        report.features.bmi2 === null,
      'Windows：FMA / F16C / BMI2 查不到，保持 unknown（不会被误判为缺失）',
    );
    expect(
      elapsed < WINDOWS_PROBE_BUDGET_MS,
      `Windows：首次探测在 ${WINDOWS_PROBE_BUDGET_MS} ms 内完成（实际 ${elapsed} ms）`,
    );
    expect(
      typeof report.detectMs === 'number' && report.fromCache !== true,
      'Windows：首次探测没有命中缓存，并记录了耗时',
    );
    const secondStart = Date.now();
    const second = await detectCpuFeatures(
      createNodeProbeDeps({ translated: false, cacheFile }),
    );
    const secondMs = Date.now() - secondStart;
    expect(
      second.fromCache === true && secondMs < CACHE_HIT_BUDGET_MS,
      `Windows：第二次命中缓存，不再起 PowerShell（${secondMs} ms）`,
    );
    expect(
      FEATURES.every((f) => second.features[f] === report.features[f]),
      'Windows：缓存里的结果与首次探测一致',
    );
  } else if (process.platform === 'darwin') {
    expect(report.source === 'sysctl', 'macOS Intel：来源是 sysctl');
    expect(
      FEATURES.every((f) => typeof report.features[f] === 'boolean'),
      'macOS Intel：五项指令集都有明确的结果',
    );
  }

  if (advisory.missing.length > 0) {
    // 不是检测的缺陷：这台机器上预编译的 whisper addon 确实跑不了
    console.log(
      `\n::warning::这台机器缺少 ${advisory.missing.join(', ')}：预编译的 whisper addon 在它上面会以“非法指令”崩溃（探测本身是正确的）`,
    );
  }

  fs.rmSync(cacheDir, { recursive: true, force: true });
  if (failures.length > 0) {
    console.error(
      `\n探测检查失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`,
    );
    process.exit(1);
  }
  console.log('\n探测检查通过');
}

void main();
