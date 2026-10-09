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

/** Windows 上首次探测要起 PowerShell；比这慢只给提示，不算失败（冷启动慢是环境问题，不是探测的缺陷） */
const WINDOWS_SLOW_PROBE_MS = 5_000;
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
    let final = report;
    let retried = false;
    if (report.source !== 'win32-ipf') {
      // 冷启动偶发很慢：真机 CI 第一次跑就遇到过一次 10 秒超时（之后三台都在 0.3 到 2.3 秒内完成，没能复现）。
      // 重试一次，区分“偶发的冷启动慢”和“探测方式本身不行”。应用里没有重试，下次启动会重新探测。
      console.log(`\n首次探测没有拿到结果（${report.note}），重试一次……`);
      const retryStart = Date.now();
      final = await detectCpuFeatures(
        createNodeProbeDeps({ translated: false, cacheFile }),
      );
      retried = true;
      console.log(
        `重试结果（${Date.now() - retryStart} ms）：source=${final.source} detectMs=${final.detectMs} note=${final.note}`,
      );
    }
    const slow = retried || (final.detectMs ?? 0) > WINDOWS_SLOW_PROBE_MS;
    if (slow) {
      console.log(
        `::warning::Windows 上 PowerShell 探测偏慢或首次失败（首次 ${elapsed} ms，${retried ? '重试后才拿到结果' : '最终拿到了结果'}）：冷启动慢是环境因素，探测本身可用`,
      );
    }
    expect(
      final.source === 'win32-ipf',
      `Windows：来源是 IsProcessorFeaturePresent${retried ? '（重试后）' : ''}`,
    );
    expect(
      typeof final.features.avx === 'boolean' &&
        typeof final.features.avx2 === 'boolean',
      'Windows：AVX / AVX2 有明确的结果',
    );
    expect(
      final.features.fma === null &&
        final.features.f16c === null &&
        final.features.bmi2 === null,
      'Windows：FMA / F16C / BMI2 查不到，保持 unknown（不会被误判为缺失）',
    );
    expect(
      typeof final.detectMs === 'number' && final.fromCache !== true,
      'Windows：实际起了 PowerShell（没有命中缓存），并记录了耗时',
    );
    const secondStart = Date.now();
    const second = await detectCpuFeatures(
      createNodeProbeDeps({ translated: false, cacheFile }),
    );
    const secondMs = Date.now() - secondStart;
    expect(
      second.fromCache === true && secondMs < CACHE_HIT_BUDGET_MS,
      `Windows：下一次命中缓存，不再起 PowerShell（${secondMs} ms）`,
    );
    expect(
      FEATURES.every((f) => second.features[f] === final.features[f]),
      'Windows：缓存里的结果与探测结果一致',
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
