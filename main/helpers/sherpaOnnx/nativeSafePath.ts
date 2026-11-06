/**
 * Windows 上让 sherpa-onnx 原生库能打开"路径里带非 ASCII 字符"的随包模型。
 *
 * 根因（GitHub Actions windows-latest 实测，代码页 1252，与中文版 GBK 同属非 UTF-8 代码页）：
 * sherpa-onnx 的 C++ 层用窄字符 API（fopen / std::ifstream）打开文件，而 Node 传进去的是
 * UTF-8 字节。系统代码页不是 UTF-8 时，这些字节被当成本地代码页解码，路径变成另一个不存在的
 * 名字：
 *   - silero VAD：构造函数静默失败，之后每次调用都打印 `vad is nullptr`，结果永远是 0 个语音段；
 *   - 降噪 / 识别 / TTS / 说话人分离：构造时抛 `Please check your config!`；
 *   - readWave 抛 `Failed to read ...`，writeWave 返回 false。
 * 用户名带中文时，默认安装目录、userData、%TEMP% 都会落在中文路径下，所以会整体失效。
 *
 * 按文件性质处理（这里只管第一类）：
 *   1. 随包的小型公共模型（silero VAD ≈ 2 MB、gtcrn ≈ 0.5 MB）：复制一份到纯 ASCII 目录，
 *      内容寻址（sha1），原生库打开副本；
 *   2. 用户音频：不复制，改由 worker 里的 JS 读写 wav（见 extraResources/sherpa/worker/wav-io.js）；
 *   3. GB 级用户模型：不搬，失败时给出可操作的提示。
 *
 * 只在 win32 且路径含非 ASCII 时介入；其余情形原样返回，ASCII 用户的行为完全不变。
 * 本模块不引用 electron，userData 由调用方传入，便于单测。
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type NativeSafeLogLevel = 'info' | 'warning' | 'error';

export interface NativeSafeOptions {
  /** 缺省取 process.platform；测试里用来模拟 Windows */
  platform?: NodeJS.Platform;
  /** 缺省取 process.env；读取 ProgramData / PUBLIC / SystemDrive */
  env?: NodeJS.ProcessEnv;
  /** Electron 的 app.getPath('userData')；含非 ASCII 时自动被剔除 */
  userDataDir?: string;
  /** 直接指定候选目录（跳过 userData / 环境变量推导），主要给测试用 */
  baseDirs?: string[];
  log?: (message: string, level: NativeSafeLogLevel) => void;
  /** 超过该大小的文件不暂存（本函数只面向随包小模型），缺省 64 MiB */
  maxBytes?: number;
}

const NON_ASCII = /[^\x00-\x7F]/;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const STAGING_SUBDIR = 'native-models';

/** 路径里是否含非 ASCII 字符（包括中文、带音标的拉丁字母、emoji）。 */
export function hasNonAscii(value: string): boolean {
  return NON_ASCII.test(value);
}

/** 原生库是否可能打不开该路径：仅 Windows 且路径含非 ASCII。 */
export function needsNativeSafe(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && hasNonAscii(filePath);
}

/**
 * 暂存目录候选，按优先级排列，自身含非 ASCII 的候选被剔除（否则暂存没有意义）：
 *   1. <userData>/native-models                       用户名是英文时的常规选择
 *   2. %ProgramData%\SmartSub\native-models           用户名含中文时的首选（所有用户可建目录）
 *   3. %PUBLIC%\SmartSub\native-models
 *   4. %SystemDrive%\SmartSub\native-models
 * 另一个 Windows 用户先写入的目录对本用户只读时，内容寻址 + 逐字节校验仍然可以复用；
 * 无法写入时自然落到下一个候选。非 Windows 不需要暂存，返回空数组。
 */
export function stagingBaseDirs(
  options: Pick<NativeSafeOptions, 'platform' | 'env' | 'userDataDir'> = {},
): string[] {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return [];
  const env = options.env ?? process.env;

  const candidates: string[] = [];
  if (options.userDataDir) {
    candidates.push(path.join(options.userDataDir, STAGING_SUBDIR));
  }
  if (env.ProgramData) {
    candidates.push(path.join(env.ProgramData, 'SmartSub', STAGING_SUBDIR));
  }
  if (env.PUBLIC) {
    candidates.push(path.join(env.PUBLIC, 'SmartSub', STAGING_SUBDIR));
  }
  if (env.SystemDrive) {
    // SystemDrive 形如 `C:`；join 会补分隔符，得到绝对路径 C:\SmartSub\native-models
    candidates.push(path.join(env.SystemDrive, 'SmartSub', STAGING_SUBDIR));
  }
  return candidates.filter(
    (dir, index) => !hasNonAscii(dir) && candidates.indexOf(dir) === index,
  );
}

interface StagedEntry {
  path: string;
  size: number;
}

/** 每进程缓存：源路径 → 已确认可用的暂存副本。 */
const stagedCache = new Map<string, StagedEntry>();

/** 仅供测试：清空每进程缓存，模拟"新进程"。 */
export function resetNativeSafePathCacheForTest(): void {
  stagedCache.clear();
}

/** 文件名里的非 ASCII 字符换成下划线；整个主干都没了就退回 model + 原扩展名。 */
function asciiFileName(name: string): string {
  const cleaned = name.replace(/[^\x20-\x7E]+/g, '_');
  const ext = path.extname(cleaned);
  const stem = cleaned.slice(0, cleaned.length - ext.length);
  return /[A-Za-z0-9]/.test(stem) ? cleaned : `model${ext}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 目标文件存在且与源内容逐字节一致。 */
function isIntactCopy(target: string, data: Buffer): boolean {
  try {
    if (fs.statSync(target).size !== data.length) return false;
    return fs.readFileSync(target).equals(data);
  } catch {
    return false;
  }
}

/** 先写临时文件再改名：避免另一个进程读到写了一半的模型。 */
function writeCopy(target: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${crypto
    .randomBytes(4)
    .toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 临时文件可能没建出来
    }
    // 目标可能刚被另一个进程写好（或正被占用）：内容正确就直接采用
    if (isIntactCopy(target, data)) return;
    throw error;
  }
}

/**
 * 把随包模型复制到纯 ASCII 目录并返回副本路径。
 * 失败（源文件读不了 / 太大 / 所有候选目录都写不了）时返回原路径并记 warning，
 * 行为不会比不处理更差。
 */
export function stageBundledModel(
  sourcePath: string,
  options: NativeSafeOptions = {},
): string {
  const log = options.log ?? (() => undefined);

  const cached = stagedCache.get(sourcePath);
  if (cached) {
    try {
      if (fs.statSync(cached.path).size === cached.size) return cached.path;
    } catch {
      // 副本被删：往下重新暂存
    }
    stagedCache.delete(sourcePath);
  }

  let data: Buffer;
  try {
    const limit = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (fs.statSync(sourcePath).size > limit) {
      log(
        `native-safe: ${sourcePath} is larger than ${limit} bytes, not staged`,
        'warning',
      );
      return sourcePath;
    }
    data = fs.readFileSync(sourcePath);
  } catch (error) {
    log(
      `native-safe: cannot read ${sourcePath} for staging: ${errorText(error)}`,
      'warning',
    );
    return sourcePath;
  }

  const digest = crypto.createHash('sha1').update(data).digest('hex');
  const name = asciiFileName(path.basename(sourcePath));
  const bases = options.baseDirs ?? stagingBaseDirs(options);
  const failures: string[] = [];

  for (const base of bases) {
    const target = path.join(base, digest.slice(0, 16), name);
    try {
      if (!isIntactCopy(target, data)) writeCopy(target, data);
      stagedCache.set(sourcePath, { path: target, size: data.length });
      log(
        `native-safe: staged ${sourcePath} -> ${target} (native libraries cannot open non-ASCII paths on Windows)`,
        'info',
      );
      return target;
    } catch (error) {
      failures.push(`${base}: ${errorText(error)}`);
    }
  }

  log(
    `native-safe: could not stage ${sourcePath} to an ASCII path, native libraries may fail to open it (${
      failures.length > 0 ? failures.join('; ') : 'no candidate directory'
    })`,
    'warning',
  );
  return sourcePath;
}

/**
 * 交给原生库之前调用：需要时返回 ASCII 副本路径，否则原样返回。
 * 空串原样返回（调用方自己决定怎么处理缺失的模型）。
 */
export function ensureNativeSafeModelPath(
  filePath: string,
  options: NativeSafeOptions = {},
): string {
  if (!filePath || !needsNativeSafe(filePath, options.platform)) {
    return filePath;
  }
  return stageBundledModel(filePath, options);
}
