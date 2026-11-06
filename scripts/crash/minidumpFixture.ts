/**
 * 合成最小的 MDMP 文件，供单测使用（不提交真实转储：Windows 主进程转储约 34 MB，
 * 且可能带内存片段）。只写摘要器会读取的三个流：SystemInfo、ModuleList、Exception。
 */

export interface FixtureModule {
  name: string;
  base: bigint;
  size: number;
}

export interface FixtureOptions {
  os: 'windows' | 'linux' | 'macos';
  arch?: 'x64' | 'arm64' | 'x86';
  cpu?: { family: number; model: number; stepping: number };
  modules?: FixtureModule[];
  exception?: { code: number; address: bigint; threadId?: number };
}

const PLATFORM_ID = { windows: 2, linux: 0x8201, macos: 0x8101 } as const;
const ARCH_ID = { x86: 0, x64: 9, arm64: 12 } as const;

function utf16String(text: string): Buffer {
  const body = Buffer.from(text, 'utf16le');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  // MINIDUMP_STRING 末尾有一个 UTF-16 的 0 终止符，长度字段不含它
  return Buffer.concat([head, body, Buffer.alloc(2)]);
}

export function buildMinidump(opts: FixtureOptions): Buffer {
  const modules = opts.modules ?? [];
  const streamTypes: number[] = [7, 4];
  if (opts.exception) streamTypes.push(6);

  const headerSize = 32;
  const dirSize = streamTypes.length * 12;
  let cursor = headerSize + dirSize;

  // SystemInfo（至少 56 字节）
  const sys = Buffer.alloc(56);
  const arch = opts.arch ?? 'x64';
  sys.writeUInt16LE(ARCH_ID[arch], 0);
  if (opts.cpu) {
    sys.writeUInt16LE(opts.cpu.family, 2);
    sys.writeUInt16LE((opts.cpu.model << 8) | opts.cpu.stepping, 4);
  }
  sys.writeUInt32LE(PLATFORM_ID[opts.os], 20);
  const sysRva = cursor;
  cursor += sys.length;

  // 模块名字符串先排好，条目里存它们的 RVA
  const moduleListSize = 4 + modules.length * 108;
  const moduleListRva = cursor;
  cursor += moduleListSize;
  const nameBuffers = modules.map((m) => utf16String(m.name));
  const nameRvas: number[] = [];
  for (const b of nameBuffers) {
    nameRvas.push(cursor);
    cursor += b.length;
  }
  const modBuf = Buffer.alloc(moduleListSize);
  modBuf.writeUInt32LE(modules.length, 0);
  modules.forEach((m, i) => {
    const at = 4 + i * 108;
    modBuf.writeBigUInt64LE(m.base, at);
    modBuf.writeUInt32LE(m.size, at + 8);
    modBuf.writeUInt32LE(nameRvas[i], at + 20);
  });

  // Exception（至少 168 字节）
  let exc: Buffer | null = null;
  let excRva = 0;
  if (opts.exception) {
    exc = Buffer.alloc(168);
    exc.writeUInt32LE(opts.exception.threadId ?? 1, 0);
    exc.writeUInt32LE(opts.exception.code >>> 0, 8);
    exc.writeBigUInt64LE(opts.exception.address, 24);
    excRva = cursor;
    cursor += exc.length;
  }

  const out = Buffer.alloc(cursor);
  out.write('MDMP', 0, 'latin1');
  out.writeUInt32LE(0xa793, 4);
  out.writeUInt32LE(streamTypes.length, 8);
  out.writeUInt32LE(headerSize, 12);

  const writeDir = (index: number, type: number, size: number, rva: number) => {
    const at = headerSize + index * 12;
    out.writeUInt32LE(type, at);
    out.writeUInt32LE(size, at + 4);
    out.writeUInt32LE(rva, at + 8);
  };
  writeDir(0, 7, sys.length, sysRva);
  writeDir(1, 4, moduleListSize, moduleListRva);
  if (exc) writeDir(2, 6, exc.length, excRva);

  sys.copy(out, sysRva);
  modBuf.copy(out, moduleListRva);
  nameBuffers.forEach((b, i) => b.copy(out, nameRvas[i]));
  if (exc) exc.copy(out, excRva);
  return out;
}
