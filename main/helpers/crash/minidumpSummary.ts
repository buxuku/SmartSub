/**
 * 极简 minidump 摘要器（纯函数 + 只读文件）：不依赖符号工具，也不读取任何内存内容。
 *
 * 输入：Crashpad 生成的 .dmp（Windows / Linux / macOS 的 MDMP 格式相同）。
 * 输出：几百字节的 JSON，包含异常码、故障模块、CPU family / model / stepping、模块名。
 * 诊断包默认只带这份摘要；原始 .dmp 由用户勾选后才带。
 *
 * 移植自 PoC（scripts/whisper-isolation-poc/isa-validation/minidump-summary.js），已用
 * windows-latest 与 ubuntu-24.04 上取回的 55 个真实转储逐个对照，输出与 PoC 完全一致：
 * - Windows 的 ExceptionAddress 就是出错指令的地址，故障模块可靠（10/10 个样本解析到模块）；
 * - Linux 上硬件触发的 SIGILL 能解析出故障模块（7/7）；而 kill / raise 发出的信号、以及
 *   SIGSEGV / SIGBUS，地址字段是数据地址或“发送者 uid<<32|pid”，不在任何模块里，模块不可解析；
 * - macOS 没有实测转储，异常类型按 Mach 异常类型尽力映射，属推断。
 *
 * 对损坏、截断或不是 MDMP 的输入返回 null，不抛错。
 */
import fs from 'fs';
import {
  buildClassification,
  classifyExit,
  type ExitClassification,
} from './exitClassifier';

const STREAM_MODULE_LIST = 4;
const STREAM_EXCEPTION = 6;
const STREAM_SYSTEM_INFO = 7;

const MAX_STREAMS = 256;
const MAX_MODULES = 4096;
const MAX_MODULE_NAME_BYTES = 2048;

// Breakpad / Crashpad 的 MD_OS_* 与 MD_CPU_ARCHITECTURE_* 常量
const OS_NAMES: Record<number, string> = {
  2: 'windows',
  0x8101: 'macos',
  0x8102: 'ios',
  0x8201: 'linux',
  0x8203: 'android',
};
const ARCH_NAMES: Record<number, string> = {
  0: 'x86',
  5: 'arm',
  9: 'x64',
  12: 'arm64',
  0x8003: 'arm64',
};

// 常见异常码的可读名字（Windows 用 NTSTATUS；Linux 用信号编号；macOS 用 Mach 异常类型）
const WIN_NAMES: Record<number, string> = {
  0xc000001d: 'ILLEGAL_INSTRUCTION',
  0xc0000005: 'ACCESS_VIOLATION',
  0xc0000409: 'FAST_FAIL',
  0xc00000fd: 'STACK_OVERFLOW',
  0xc0000374: 'HEAP_CORRUPTION',
  0xc0000094: 'INT_DIVIDE_BY_ZERO',
  0xc0000096: 'PRIV_INSTRUCTION',
  0x80000003: 'BREAKPOINT',
};
const LINUX_NAMES: Record<number, string> = {
  4: 'SIGILL',
  5: 'SIGTRAP',
  6: 'SIGABRT',
  7: 'SIGBUS',
  8: 'SIGFPE',
  11: 'SIGSEGV',
};
const MAC_NAMES: Record<number, string> = {
  1: 'EXC_BAD_ACCESS',
  2: 'EXC_BAD_INSTRUCTION',
  3: 'EXC_ARITHMETIC',
  5: 'EXC_SOFTWARE',
  6: 'EXC_BREAKPOINT',
  10: 'EXC_CRASH',
};

export interface MinidumpSummary {
  bytes: number;
  os?: string;
  arch?: string;
  /** 仅 x86 / x64：ProcessorLevel = family，ProcessorRevision 高字节 = model、低字节 = stepping */
  cpu?: { family: number; model: number; stepping: number };
  exception: {
    code: number;
    codeHex: string;
    name: string;
    threadId: number;
    address: string;
  } | null;
  faultModule: { name: string; base: string; offset: string } | null;
  moduleCount: number;
  /** 只列模块名（不含路径，避免把用户目录写进摘要），去重后截断 */
  modules: string[];
}

/** 随机读取的字节来源：大转储（Windows 主进程约 34 MB）不必整份读入内存。 */
export interface ByteSource {
  size: number;
  read(offset: number, length: number): Buffer;
}

export function bufferSource(buf: Buffer): ByteSource {
  return {
    size: buf.length,
    read: (offset, length) =>
      offset < 0 || offset >= buf.length
        ? Buffer.alloc(0)
        : buf.subarray(offset, Math.min(offset + length, buf.length)),
  };
}

function readExact(
  src: ByteSource,
  offset: number,
  length: number,
): Buffer | null {
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  if (!Number.isSafeInteger(length) || length < 0) return null;
  const buf = src.read(offset, length);
  return buf.length === length ? buf : null;
}

function hex(n: number | bigint, width = 0): string {
  return '0x' + BigInt(n).toString(16).padStart(width, '0');
}

function baseName(p: string): string {
  // 模块名里可能是 Windows 路径，也可能是 POSIX 路径
  return p.split(/[\\/]/).pop() || p;
}

function readUtf16String(src: ByteSource, rva: number): string {
  const head = readExact(src, rva, 4);
  if (!head) return '';
  const bytes = Math.min(head.readUInt32LE(0), MAX_MODULE_NAME_BYTES);
  const body = src.read(rva + 4, bytes);
  return body.toString('utf16le');
}

interface Stream {
  size: number;
  rva: number;
}

interface ModuleEntry {
  base: bigint;
  size: bigint;
  name: string;
}

function readModules(src: ByteSource, rva: number): ModuleEntry[] {
  const head = readExact(src, rva, 4);
  if (!head) return [];
  const count = Math.min(head.readUInt32LE(0), MAX_MODULES);
  const entries = src.read(rva + 4, count * 108);
  const modules: ModuleEntry[] = [];
  for (let i = 0; i < count; i++) {
    const at = i * 108;
    if (at + 108 > entries.length) break;
    modules.push({
      base: entries.readBigUInt64LE(at),
      size: BigInt(entries.readUInt32LE(at + 8)),
      name: readUtf16String(src, entries.readUInt32LE(at + 20)),
    });
  }
  return modules;
}

export function summarizeMinidump(
  src: ByteSource,
  maxModules = 12,
): MinidumpSummary | null {
  const header = readExact(src, 0, 32);
  if (!header || header.toString('latin1', 0, 4) !== 'MDMP') return null;

  try {
    const streamCount = Math.min(header.readUInt32LE(8), MAX_STREAMS);
    const dirRva = header.readUInt32LE(12);
    const dir = src.read(dirRva, streamCount * 12);
    const streams: Record<number, Stream> = {};
    for (let i = 0; i < streamCount; i++) {
      const at = i * 12;
      if (at + 12 > dir.length) break;
      streams[dir.readUInt32LE(at)] = {
        size: dir.readUInt32LE(at + 4),
        rva: dir.readUInt32LE(at + 8),
      };
    }

    const out: MinidumpSummary = {
      bytes: src.size,
      exception: null,
      faultModule: null,
      moduleCount: 0,
      modules: [],
    };

    // ---- SystemInfo：平台、架构、CPU 家族 / 型号 ----
    let platformId = 0;
    const sys = streams[STREAM_SYSTEM_INFO];
    const sysBuf = sys ? readExact(src, sys.rva, 24) : null;
    if (sysBuf) {
      const archId = sysBuf.readUInt16LE(0);
      platformId = sysBuf.readUInt32LE(20);
      out.os = OS_NAMES[platformId] || hex(platformId);
      out.arch = ARCH_NAMES[archId] || hex(archId);
      if (archId === 0 || archId === 9) {
        // x64 的 dump 里 CPU 联合体存的是 ProcessorFeatures 位图（不是 vendor / cpuid 签名），
        // 但头部的 ProcessorLevel = family，ProcessorRevision = (model << 8) | stepping，
        // 足以对应到微架构（例：Intel family 6 model 58 = Ivy Bridge；AMD family 25 model 1 = Zen 3）。
        const level = sysBuf.readUInt16LE(2);
        const revision = sysBuf.readUInt16LE(4);
        out.cpu = {
          family: level,
          model: revision >> 8,
          stepping: revision & 0xff,
        };
      }
    }

    // ---- 模块列表 ----
    const modStream = streams[STREAM_MODULE_LIST];
    const modules = modStream ? readModules(src, modStream.rva) : [];
    out.moduleCount = modules.length;

    // ---- 异常流 ----
    const exc = streams[STREAM_EXCEPTION];
    const excBuf = exc ? readExact(src, exc.rva, 32) : null;
    if (excBuf) {
      const code = excBuf.readUInt32LE(8);
      const address = excBuf.readBigUInt64LE(24);
      let name = '';
      if (platformId === 2) name = WIN_NAMES[code] || '';
      else if (platformId === 0x8201 || platformId === 0x8203) {
        name = LINUX_NAMES[code] || '';
      } else if (platformId === 0x8101) name = MAC_NAMES[code] || '';
      out.exception = {
        code,
        codeHex: hex(code, 8),
        name,
        threadId: excBuf.readUInt32LE(0),
        address: hex(address),
      };
      const hit = modules.find(
        (m) => address >= m.base && address < m.base + m.size,
      );
      out.faultModule = hit
        ? {
            name: baseName(hit.name),
            base: hex(hit.base),
            offset: hex(address - hit.base),
          }
        : null;
    }

    const names = [...new Set(modules.map((m) => baseName(m.name)))];
    out.modules = names.slice(0, maxModules);
    if (names.length > maxModules) {
      out.modules.push(`…(+${names.length - maxModules})`);
    }
    return out;
  } catch {
    return null;
  }
}

/** 读文件并生成摘要；文件不存在、读失败或不是 MDMP 时返回 null。 */
export function summarizeMinidumpFile(
  file: string,
  maxModules = 12,
): MinidumpSummary | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const handle = fd;
    return summarizeMinidump(
      {
        size,
        read(offset, length) {
          if (offset < 0 || offset >= size) return Buffer.alloc(0);
          const len = Math.min(length, size - offset);
          const buf = Buffer.alloc(len);
          const n = fs.readSync(handle, buf, 0, len, offset);
          return n === len ? buf : buf.subarray(0, n);
        },
      },
      maxModules,
    );
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // 关闭失败不影响结果
      }
    }
  }
}

/**
 * 把转储里的异常归类，供熔断判断“是不是指令集问题”。
 * Windows 用 NTSTATUS，Linux 用信号编号；macOS 的 Mach 异常类型尽力映射，未实测。
 */
export function classifySummaryException(
  summary: MinidumpSummary,
): ExitClassification | null {
  const ex = summary.exception;
  if (!ex) return null;
  switch (summary.os) {
    case 'windows':
      return classifyExit({
        platform: 'win32',
        exitCode: ex.code,
        reason: 'crashed',
      });
    case 'linux':
    case 'android':
      return classifyExit({
        platform: 'linux',
        exitCode: ex.code,
        reason: 'crashed',
      });
    case 'macos':
      switch (ex.code) {
        case 1:
          return buildClassification('access-violation', 'EXC_BAD_ACCESS');
        case 2:
          return buildClassification(
            'illegal-instruction',
            'EXC_BAD_INSTRUCTION',
          );
        case 3:
          return buildClassification('arithmetic', 'EXC_ARITHMETIC');
        case 6:
          return buildClassification('breakpoint', 'EXC_BREAKPOINT');
        default:
          return buildClassification(
            'crash-unknown',
            MAC_NAMES[ex.code] || `EXC_${ex.code}`,
          );
      }
    default:
      return null;
  }
}
