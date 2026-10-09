import type { Suppression } from '../../main/helpers/crash/breaker';
import { FAMILY_KEY } from '../../main/helpers/crash/breaker';
import {
  WhisperUnavailableError,
  buildAllSuppressedError,
  candidateKeyOf,
  describeSuppressed,
  gpuFingerprint,
  partitionCandidates,
  type LoaderCandidateLike,
} from '../../main/helpers/crash/addonSuppression';
import { assert, finish, test } from './testkit';

const VULKAN: LoaderCandidateLike = {
  backend: 'vulkan',
  variant: 'vulkan',
  source: 'builtin',
  path: '/app/addons/addon.vulkan.node',
};
const CUDA: LoaderCandidateLike = {
  backend: 'cuda',
  variant: '12.4.0',
  source: 'userData',
  path: '/data/addons/12.4.0/addon.node',
};
const CPU: LoaderCandidateLike = {
  backend: 'cpu',
  variant: null,
  source: 'builtin',
  path: '/app/addons/addon.node',
};
const CUSTOM: LoaderCandidateLike = {
  backend: 'custom',
  variant: null,
  source: 'custom',
  path: '/x/custom.node',
};

function suppression(extra: Partial<Suppression> = {}): Suppression {
  return {
    scope: 'candidate',
    key: 'builtin:vulkan',
    reason: 'crash',
    evidence: 'strong',
    since: 1,
    fingerprint: {},
    ...extra,
  };
}

const FAMILY = suppression({
  scope: 'family',
  key: FAMILY_KEY,
  reason: 'isa',
  detail: 'illegal-instruction (ILLEGAL_INSTRUCTION 0xC000001D)',
});

async function main() {
  await test('候选键与熔断表使用同一套命名', () => {
    assert.equal(candidateKeyOf(VULKAN), 'builtin:vulkan');
    assert.equal(candidateKeyOf(CUDA), 'userData:cuda:12.4.0');
    assert.equal(candidateKeyOf(CPU), 'builtin:cpu');
    assert.equal(candidateKeyOf(CUSTOM), 'custom:custom');
  });

  await test('筛选：被抑制的拿出来，其余保持原有优先级顺序', () => {
    const lookup = (key: string) =>
      key === 'builtin:vulkan' ? suppression() : null;
    const { usable, skipped } = partitionCandidates(
      [CUSTOM, CUDA, VULKAN, CPU],
      lookup,
    );
    assert.deepEqual(usable, [CUSTOM, CUDA, CPU]);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].candidate, VULKAN);
  });

  await test('没有任何抑制时原样返回', () => {
    const list = [VULKAN, CPU];
    const { usable, skipped } = partitionCandidates(list, () => null);
    assert.deepEqual(usable, list);
    assert.deepEqual(skipped, []);
  });

  await test('抑制说明：区分指令集、单次强证据、连续两次的弱证据；带上崩溃详情；不含路径', () => {
    assert.match(describeSuppressed(FAMILY), /instruction set/);
    assert.match(describeSuppressed(FAMILY), /0xC000001D/);
    assert.match(describeSuppressed(suppression()), /crashed the app/);
    assert.match(
      describeSuppressed(suppression({ evidence: 'weak' })),
      /abnormally twice in a row/,
    );
    for (const s of [FAMILY, suppression()]) {
      assert.ok(!describeSuppressed(s).includes('/'), describeSuppressed(s));
    }
  });

  await test('显卡指纹：名称排序后拼接，加上 NVIDIA 驱动版本；信息缺失时也给稳定结果', () => {
    assert.equal(
      gpuFingerprint({
        gpus: [{ name: 'NVIDIA GeForce GTX 1060' }, { name: 'Intel UHD 630' }],
        nvidia: { gpuSupport: { driverVersion: '551.23' } },
      }),
      'Intel UHD 630 / NVIDIA GeForce GTX 1060@551.23',
    );
    assert.equal(
      gpuFingerprint({ gpus: [{ name: 'AMD Radeon RX 6600' }], nvidia: null }),
      'AMD Radeon RX 6600@',
    );
    assert.equal(gpuFingerprint({}), '@');
    // 顺序不同的同一组显卡指纹相同
    assert.equal(
      gpuFingerprint({ gpus: [{ name: 'B' }, { name: 'A' }] }),
      gpuFingerprint({ gpus: [{ name: 'A' }, { name: 'B' }] }),
    );
  });

  await test('整族因指令集被抑制：错误引导用云端听写，类型与原因可供调用方识别', () => {
    const skipped = [VULKAN, CPU].map((candidate) => ({
      candidate,
      suppression: FAMILY,
    }));
    const zh = buildAllSuppressedError(skipped, {
      language: 'zh',
      gpuOnly: false,
    });
    assert.ok(zh instanceof WhisperUnavailableError);
    assert.equal(zh.code, 'WHISPER_SUPPRESSED');
    assert.equal(zh.reason, 'isa');
    assert.match(zh.message, /云端听写/);
    assert.match(zh.message, /0xC000001D/);
    assert.match(zh.message, /重新尝试被停用的后端/);

    const en = buildAllSuppressedError(skipped, {
      language: 'en',
      gpuOnly: false,
    });
    assert.match(en.message, /cloud transcription/);
    assert.match(en.message, /instruction set/);
    assert.match(en.message, /Retry disabled backends/);
    assert.ok(!/[\u4e00-\u9fff]/.test(en.message), en.message);
  });

  await test('GPU-only 模式下全被抑制：仍然报错，不静默落到 CPU，并说明可切到自动模式', () => {
    const skipped = [
      { candidate: VULKAN, suppression: suppression() },
      {
        candidate: CUDA,
        suppression: suppression({ key: 'userData:cuda:12.4.0' }),
      },
    ];
    const en = buildAllSuppressedError(skipped, {
      language: 'en',
      gpuOnly: true,
    });
    assert.equal(en.reason, 'crash');
    assert.match(en.message, /GPU-only mode/);
    assert.match(en.message, /vulkan/);
    assert.match(en.message, /cuda 12\.4\.0/);
    assert.match(en.message, /Auto mode/);
    const zh = buildAllSuppressedError(skipped, {
      language: 'zh',
      gpuOnly: true,
    });
    assert.match(zh.message, /仅 GPU 模式/);
    assert.match(zh.message, /自动/);
  });

  await test('自动模式下全被抑制（非指令集）：列出被停用的后端并引导云端听写；同名后端只列一次', () => {
    const skipped = [
      { candidate: VULKAN, suppression: suppression() },
      { candidate: VULKAN, suppression: suppression() },
      { candidate: CPU, suppression: suppression({ key: 'builtin:cpu' }) },
    ];
    const error = buildAllSuppressedError(skipped, {
      language: 'en',
      gpuOnly: false,
    });
    assert.equal(error.reason, 'crash');
    assert.match(error.message, /\(vulkan, cpu\)/);
    assert.match(error.message, /cloud transcription/);
  });

  await test('错误信息里没有路径（只有后端名）', () => {
    const skipped = [VULKAN, CUDA, CPU].map((candidate) => ({
      candidate,
      suppression: suppression(),
    }));
    for (const language of ['zh', 'en'] as const) {
      const { message } = buildAllSuppressedError(skipped, {
        language,
        gpuOnly: false,
      });
      assert.ok(!message.includes('/app/'), message);
      assert.ok(!message.includes('/data/'), message);
    }
  });

  finish('addon-suppression');
}

main();
