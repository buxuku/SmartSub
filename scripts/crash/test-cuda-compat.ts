import {
  CUDA_PACKAGE_MIN_COMPUTE_CAPABILITY,
  attachComputeCapabilities,
  findCudaIncompatibility,
  parseNvidiaSmiComputeCaps,
  partitionByCudaCompat,
} from '../../main/helpers/crash/cudaCompat';
import type { GpuInfo } from '../../types/addon';
import { assert, finish, test } from './testkit';

const PASCAL = 'GPU-abcdef01-1111-1111-1111-111111111111';
const AMPERE = 'GPU-22222222-2222-2222-2222-222222222222';
const MYSTERY = 'GPU-33333333-3333-3333-3333-333333333333';

function nvidia(
  name: string,
  uuid: string,
  computeCapability?: number,
): GpuInfo {
  return {
    name,
    vendor: 'nvidia',
    index: 0,
    uuid,
    ...(computeCapability === undefined ? {} : { computeCapability }),
  };
}

const GTX_1060 = nvidia('NVIDIA GeForce GTX 1060', PASCAL, 6.1);
const RTX_3060 = nvidia('NVIDIA GeForce RTX 3060', AMPERE, 8.6);
const UNKNOWN_CARD = nvidia('NVIDIA Some Card', MYSTERY);

async function main() {
  await test('13.0.2 的最低算力是核对过构建配置的 7.5；未核对的旧包不在表里', () => {
    assert.equal(CUDA_PACKAGE_MIN_COMPUTE_CAPABILITY['13.0.2'], 7.5);
    for (const unverified of ['11.8.0', '12.2.0', '12.4.0', 'vulkan']) {
      assert.equal(
        CUDA_PACKAGE_MIN_COMPUTE_CAPABILITY[unverified],
        undefined,
        unverified,
      );
    }
  });

  await test('GTX 1060（6.1）上的 13.0.2 包被判不兼容，说明里有显卡名、算力与要求', () => {
    const result = findCudaIncompatibility('13.0.2', [GTX_1060]);
    assert.ok(result);
    assert.equal(result.minComputeCapability, 7.5);
    assert.equal(
      result.reason,
      'CUDA 13.0.2 addon needs compute capability >= 7.5; GPU: NVIDIA GeForce GTX 1060 (6.1)',
    );
  });

  await test('刚好达标（7.5）或更高的显卡不受影响', () => {
    for (const cap of [7.5, 8.0, 8.6, 8.9, 9.0, 10.0, 12.0]) {
      assert.equal(
        findCudaIncompatibility('13.0.2', [nvidia('X', PASCAL, cap)]),
        null,
        String(cap),
      );
    }
    assert.ok(findCudaIncompatibility('13.0.2', [nvidia('X', PASCAL, 7.4)]));
    assert.ok(findCudaIncompatibility('13.0.2', [nvidia('X', PASCAL, 7.0)]));
  });

  await test('算力未知时不下结论：只要有一块显卡的算力不明，就保留', () => {
    assert.equal(findCudaIncompatibility('13.0.2', [UNKNOWN_CARD]), null);
    assert.equal(
      findCudaIncompatibility('13.0.2', [GTX_1060, UNKNOWN_CARD]),
      null,
    );
  });

  await test('多块显卡：只要有一块达标就保留（无法断定会用到哪一块）', () => {
    assert.equal(findCudaIncompatibility('13.0.2', [GTX_1060, RTX_3060]), null);
  });

  await test('用户在设置里选了显卡：只看被选中的那一块', () => {
    const gpus = [GTX_1060, RTX_3060];
    assert.ok(findCudaIncompatibility('13.0.2', gpus, PASCAL));
    assert.equal(findCudaIncompatibility('13.0.2', gpus, AMPERE), null);
    // UUID 的十六进制部分大小写不敏感（前缀 GPU- 是固定写法）
    assert.ok(
      findCudaIncompatibility(
        '13.0.2',
        gpus,
        'GPU-ABCDEF01-1111-1111-1111-111111111111',
      ),
    );
  });

  await test('选中的显卡已不存在、或选择值不合法：按未选择处理，不会误剔', () => {
    const gpus = [GTX_1060, RTX_3060];
    assert.equal(
      findCudaIncompatibility('13.0.2', gpus, 'GPU-gone-0000'),
      null,
    );
    assert.equal(findCudaIncompatibility('13.0.2', gpus, 'not a uuid'), null);
    assert.ok(findCudaIncompatibility('13.0.2', [GTX_1060], 'not a uuid'));
  });

  await test('没有 NVIDIA 显卡、没有变体、未收录的变体：一律不判', () => {
    assert.equal(findCudaIncompatibility('13.0.2', []), null);
    assert.equal(
      findCudaIncompatibility('13.0.2', [
        { name: 'AMD Radeon', vendor: 'amd', computeCapability: 1 },
      ]),
      null,
    );
    assert.equal(findCudaIncompatibility(null, [GTX_1060]), null);
    assert.equal(findCudaIncompatibility('12.4.0', [GTX_1060]), null);
    assert.equal(findCudaIncompatibility('11.8.0', [GTX_1060]), null);
  });

  await test('解析 nvidia-smi 的 uuid,compute_cap：多行、空格、Windows 换行；[N/A] 与乱码跳过', () => {
    const caps = parseNvidiaSmiComputeCaps(
      [
        `${PASCAL}, 6.1`,
        `${AMPERE.toUpperCase()},8.6\r`,
        `${MYSTERY}, [N/A]`,
        'garbage line',
        '',
        `GPU-44444444-4444-4444-4444-444444444444, 12.0`,
      ].join('\n'),
    );
    assert.equal(caps.get(PASCAL.toLowerCase()), 6.1);
    assert.equal(caps.get(AMPERE.toLowerCase()), 8.6);
    assert.equal(caps.has(MYSTERY.toLowerCase()), false);
    assert.equal(caps.get('gpu-44444444-4444-4444-4444-444444444444'), 12);
    assert.equal(caps.size, 3);
  });

  await test('旧驱动的报错输出与空输出解析为空表（全部未知）', () => {
    assert.equal(
      parseNvidiaSmiComputeCaps('Field "compute_cap" is not a valid field')
        .size,
      0,
    );
    assert.equal(parseNvidiaSmiComputeCaps('').size, 0);
  });

  await test('attachComputeCapabilities：按 UUID（不分大小写）对应，查不到的保持未知，不改原对象', () => {
    const caps = new Map([[PASCAL.toLowerCase(), 6.1]]);
    const input = [
      nvidia('A', 'GPU-ABCDEF01-1111-1111-1111-111111111111'),
      nvidia('B', AMPERE),
      { name: 'No uuid', vendor: 'nvidia' as const },
    ];
    const out = attachComputeCapabilities(input, caps);
    assert.equal(out[0].computeCapability, 6.1);
    assert.equal(out[1].computeCapability, undefined);
    assert.equal(out[2].computeCapability, undefined);
    assert.equal(input[0].computeCapability, undefined);
  });

  await test('partitionByCudaCompat：只剔除算力不够的 CUDA 包，Vulkan、CPU、自定义原样保留且顺序不变', () => {
    const candidates = [
      { backend: 'custom', variant: null, tag: 'custom' },
      { backend: 'cuda', variant: '13.0.2', tag: 'cuda13' },
      { backend: 'cuda', variant: '12.4.0', tag: 'cuda12' },
      { backend: 'vulkan', variant: 'vulkan', tag: 'vulkan' },
      { backend: 'cpu', variant: null, tag: 'cpu' },
    ];
    const { kept, incompatible } = partitionByCudaCompat(candidates, [
      GTX_1060,
    ]);
    assert.deepEqual(
      kept.map((c) => c.tag),
      ['custom', 'cuda12', 'vulkan', 'cpu'],
    );
    assert.deepEqual(
      incompatible.map((i) => i.candidate.tag),
      ['cuda13'],
    );
    assert.match(incompatible[0].incompatibility.reason, /GTX 1060 \(6\.1\)/);
  });

  await test('partitionByCudaCompat：显卡信息缺失时一个都不剔', () => {
    const candidates = [{ backend: 'cuda', variant: '13.0.2' }];
    const { kept, incompatible } = partitionByCudaCompat(candidates, []);
    assert.equal(kept.length, 1);
    assert.equal(incompatible.length, 0);
  });

  finish('cuda-compat');
}

void main();
