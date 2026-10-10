import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bufferSource,
  classifySummaryException,
  summarizeMinidump,
  summarizeMinidumpFile,
} from '../../main/helpers/crash/minidumpSummary';
import { buildMinidump } from './minidumpFixture';
import { assert, finish, test } from './testkit';

const WIN_ADDON =
  'C:\\Program Files\\SmartSub\\resources\\extraResources\\addons\\addon.vulkan.node';

async function main() {
  await test('Windows x64：非法指令落在 addon 里，能读出异常码、故障模块与 CPU 型号', () => {
    const dump = buildMinidump({
      os: 'windows',
      cpu: { family: 6, model: 58, stepping: 9 }, // Intel family 6 model 58 = Ivy Bridge
      modules: [
        {
          name: 'C:\\Windows\\System32\\ntdll.dll',
          base: 0x7ff800000000n,
          size: 0x200000,
        },
        { name: WIN_ADDON, base: 0x7ff700000000n, size: 0x800000 },
      ],
      exception: { code: 0xc000001d, address: 0x7ff700123456n, threadId: 7 },
    });
    const s = summarizeMinidump(bufferSource(dump));
    assert.ok(s);
    assert.equal(s.os, 'windows');
    assert.equal(s.arch, 'x64');
    assert.deepEqual(s.cpu, { family: 6, model: 58, stepping: 9 });
    assert.equal(s.exception?.codeHex, '0xc000001d');
    assert.equal(s.exception?.name, 'ILLEGAL_INSTRUCTION');
    assert.equal(s.exception?.threadId, 7);
    assert.equal(s.faultModule?.name, 'addon.vulkan.node');
    assert.equal(s.faultModule?.offset, '0x123456');
    assert.equal(s.moduleCount, 2);
    const c = classifySummaryException(s);
    assert.equal(c?.kind, 'illegal-instruction');
    assert.equal(c?.isIsa, true);
  });

  await test('摘要里只有模块名，没有任何路径（避免把用户目录写进诊断包）', () => {
    const dump = buildMinidump({
      os: 'windows',
      modules: [{ name: WIN_ADDON, base: 0x1000n, size: 0x1000 }],
      exception: { code: 0xc0000005, address: 0x1800n },
    });
    const json = JSON.stringify(summarizeMinidump(bufferSource(dump)));
    assert.ok(!json.includes('Program Files'));
    assert.ok(!json.includes('\\\\'));
    assert.ok(json.includes('addon.vulkan.node'));
    assert.ok(json.length < 1024, `摘要应当很小，实际 ${json.length} 字节`);
  });

  await test('Linux：SIGILL 与 SIGSEGV 的名字与归类', () => {
    const ill = summarizeMinidump(
      bufferSource(
        buildMinidump({
          os: 'linux',
          modules: [
            {
              name: '/opt/SmartSub/resources/addon.node',
              base: 0x5000n,
              size: 0x1000,
            },
          ],
          exception: { code: 4, address: 0x5100n },
        }),
      ),
    );
    assert.equal(ill?.os, 'linux');
    assert.equal(ill?.exception?.name, 'SIGILL');
    assert.equal(ill?.faultModule?.name, 'addon.node');
    assert.equal(classifySummaryException(ill!)?.isIsa, true);

    const segv = summarizeMinidump(
      bufferSource(
        buildMinidump({
          os: 'linux',
          modules: [{ name: '/lib/libc.so.6', base: 0x5000n, size: 0x1000 }],
          // SIGSEGV 的地址是数据地址，不在任何模块里：模块不可解析（PoC 实测）
          exception: { code: 11, address: 0xdead0000n },
        }),
      ),
    );
    assert.equal(segv?.exception?.name, 'SIGSEGV');
    assert.equal(segv?.faultModule, null);
    assert.equal(classifySummaryException(segv!)?.kind, 'access-violation');

    // 5 号信号：本机留存的真实 Linux 转储里出现过，之前没有名字
    const trap = summarizeMinidump(
      bufferSource(
        buildMinidump({ os: 'linux', exception: { code: 5, address: 0n } }),
      ),
    );
    assert.equal(trap?.exception?.name, 'SIGTRAP');
    assert.equal(classifySummaryException(trap!)?.kind, 'breakpoint');
  });

  await test('macOS arm64：Mach 异常类型尽力映射（未实测）', () => {
    const bad = summarizeMinidump(
      bufferSource(
        buildMinidump({
          os: 'macos',
          arch: 'arm64',
          exception: { code: 1, address: 0n },
        }),
      ),
    );
    assert.equal(bad?.os, 'macos');
    assert.equal(bad?.arch, 'arm64');
    assert.equal(bad?.cpu, undefined);
    assert.equal(bad?.exception?.name, 'EXC_BAD_ACCESS');
    assert.equal(classifySummaryException(bad!)?.kind, 'access-violation');
    const ill = summarizeMinidump(
      bufferSource(
        buildMinidump({
          os: 'macos',
          arch: 'arm64',
          exception: { code: 2, address: 0n },
        }),
      ),
    );
    assert.equal(classifySummaryException(ill!)?.isIsa, true);
  });

  await test('没有异常流的转储：exception 为 null', () => {
    const s = summarizeMinidump(bufferSource(buildMinidump({ os: 'windows' })));
    assert.ok(s);
    assert.equal(s.exception, null);
    assert.equal(s.faultModule, null);
    assert.equal(classifySummaryException(s), null);
  });

  await test('模块太多时截断并标注数量', () => {
    const modules = Array.from({ length: 20 }, (_, i) => ({
      name: `C:\\x\\m${i}.dll`,
      base: BigInt(0x10000 * (i + 1)),
      size: 0x1000,
    }));
    const s = summarizeMinidump(
      bufferSource(buildMinidump({ os: 'windows', modules })),
      5,
    );
    assert.equal(s?.moduleCount, 20);
    assert.equal(s?.modules.length, 6);
    assert.equal(s?.modules[5], '…(+15)');
  });

  await test('不是 MDMP、空文件、任意截断都返回 null 或部分摘要，绝不抛错', () => {
    assert.equal(summarizeMinidump(bufferSource(Buffer.alloc(0))), null);
    assert.equal(
      summarizeMinidump(
        bufferSource(Buffer.from('not a minidump at all, just text')),
      ),
      null,
    );
    const dump = buildMinidump({
      os: 'windows',
      modules: [{ name: WIN_ADDON, base: 0x1000n, size: 0x1000 }],
      exception: { code: 0xc0000005, address: 0x1800n },
    });
    for (let len = 0; len < dump.length; len += 7) {
      summarizeMinidump(bufferSource(dump.subarray(0, len)));
    }
    // 流目录指向文件之外
    const broken = Buffer.from(dump);
    broken.writeUInt32LE(0xfffffff0, 12);
    assert.doesNotThrow(() => summarizeMinidump(bufferSource(broken)));
    // 模块数量夸大：改写 ModuleList 流开头的计数（流目录第 2 项的 RVA）
    const huge = Buffer.from(dump);
    const moduleListRva = huge.readUInt32LE(32 + 12 + 8);
    huge.writeUInt32LE(0xffffffff, moduleListRva);
    assert.doesNotThrow(() => summarizeMinidump(bufferSource(huge)));
  });

  await test('按文件读取与按缓冲读取结果一致；文件不存在返回 null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-minidump-'));
    try {
      const dump = buildMinidump({
        os: 'windows',
        cpu: { family: 25, model: 1, stepping: 1 },
        modules: [{ name: WIN_ADDON, base: 0x1000n, size: 0x1000 }],
        exception: { code: 0xc0000005, address: 0x1800n },
      });
      const file = path.join(dir, 'a.dmp');
      fs.writeFileSync(file, dump);
      assert.deepEqual(
        summarizeMinidumpFile(file),
        summarizeMinidump(bufferSource(dump)),
      );
      assert.equal(summarizeMinidumpFile(path.join(dir, 'missing.dmp')), null);
      fs.writeFileSync(path.join(dir, 'junk.dmp'), 'hello');
      assert.equal(summarizeMinidumpFile(path.join(dir, 'junk.dmp')), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  finish('minidumpSummary');
}

main();
