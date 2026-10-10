/**
 * 通用显卡枚举（名称 + 厂商）。只依赖注入进来的函数，不碰 electron，便于在 CI 里直接测。
 *
 * Windows 不能走 systeminformation.graphics()（本仓库锁定的 5.27.7）：
 *   - 它一次拉起 7 个 PowerShell（powershell -NoProfile -NoLogo -InputFormat Text -NoExit
 *     -ExecutionPolicy Unrestricted -Command -），并往每个子进程的 stdin 写命令
 *     （write → write('exit') → end()），却从不给 stdin 挂 'error' 监听；
 *     同时它在 PowerShell 的 stderr 上只要有任何输出就 child.kill()。
 *     Windows 上管道写入是异步的：第一次写在途，第二次写先进缓冲区，等第一次完成后才从 clearBuffer 发出。
 *     只要子进程在这之前就没了（退出、被杀、被策略拦截……），这次写入就会遇到 EPIPE：
 *     它是主进程里没人接的异步 'error' 事件，表现为启动即弹
 *     “A JavaScript error occurred in the main process: Error: write EPIPE”。
 *     调用方的 try/catch / Promise.race / .catch() 都拦不住它。
 *     已在 windows-latest 真机上，用“启动即退出的 PowerShell”复现：Electron 30.5.1（Node 20.16.0）里
 *     崩溃的栈与用户截图逐帧一致（clearBuffer ← onwrite ← onWriteComplete）。
 *     用户机器上的 PowerShell 为什么会提前没了，目前没有结论：真机上的自然运行（空闲、CPU 满载、
 *     并发 3 次 graphics()）都没有触发，PowerShell 也没有往 stderr 写东西。所以这里不依赖具体原因，
 *     只是把这条危险路径拿掉。
 *   - 连续 7 次 spawn，外加同步的 execSync nvidia-smi，会让主线程长时间顾不上处理 I/O；
 *     启动期又有好几处并发来要 GPU 环境（见 cudaUtils.ts 的单飞缓存）。
 *     windows-latest 真机上，3 路并发的 graphics() 要 5.5 到 12.9 秒。
 * 这里只起一个 PowerShell：命令走 argv，不写 stdin，不因为 stderr 杀进程，失败/超时一律降级。
 */

/**
 * 跑外部命令取标准输出。失败、超时、非零退出返回 null，或抛出带原因的错误
 * （runCommand.ts 的 runCommandOrThrow：超时 / 退出码加 stderr 首行 / 起不来），原因会进日志。
 */
export type RunCommand = (
  file: string,
  args: string[],
  timeoutMs: number,
) => Promise<string | null>;

/** 显卡的原始描述：model 对应 Win32_VideoController.Name，vendor 对应 AdapterCompatibility。 */
export interface RawGpu {
  model: string;
  vendor: string;
}

/**
 * Windows 探测的时间上限：冷启动的 PowerShell 可以慢得超过 10 秒。
 * windows-latest 真机上，这条探测的第一次运行在 10 秒处被终止（10137 ms），随后的重试 4.1 秒；
 * 另一台 runner 上首次运行 2.5 秒，同一台上再跑一次只要 0.3 秒。
 * 预算给短了，慢机器上第一次探测就会超时降级，而降级后的结果会被缓存到本次会话结束。
 * 应用启动时就会预热（background.ts），并发调用共享同一次探测，所以多出来的余量通常不会拖慢开始任务。
 */
export const WINDOWS_GPU_PROBE_TIMEOUT_MS = 30_000;

const GPU_LINE = /^GPU=(.*)$/;

/**
 * Windows 探测命令：绝对路径定位 powershell.exe（避免被 PATH 里的同名程序劫持），
 * 故意不用 -EncodedCommand / -ExecutionPolicy（恶意脚本的常见写法，容易被杀软盯上）。
 * 脚本里不能出现双引号：Windows 命令行转义会把它改坏。
 */
export function buildWindowsGpuProbeCommand(systemRoot = 'C:\\Windows'): {
  file: string;
  args: string[];
} {
  const script =
    // 不需要进度输出：关掉，免得输出被重定向时多出一堆无关内容
    `$ErrorActionPreference = 'SilentlyContinue'; $ProgressPreference = 'SilentlyContinue'; ` +
    // 让本地化的显卡名以 UTF-8 输出；受限语言模式下这句会失败，吞掉即可（顶多显示乱码，不影响厂商判断）
    `try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; ` +
    `Get-CimInstance Win32_VideoController | ForEach-Object { 'GPU=' + $_.Name + '|' + $_.AdapterCompatibility }`;
  return {
    file: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
  };
}

/** 解析探测输出：每行形如 `GPU=名称|厂商`；BOM、编译警告之类的噪声行忽略。 */
export function parseWindowsGpuProbeOutput(output: string | null): RawGpu[] {
  const gpus: RawGpu[] = [];
  for (const rawLine of (output ?? '').split(/\r?\n/)) {
    const match = rawLine
      .replace(/^\uFEFF/, '')
      .trim()
      .match(GPU_LINE);
    if (!match) continue;
    // 厂商名几乎不会带 |，名称里偶尔会：按最后一个 | 切分
    const body = match[1];
    const cut = body.lastIndexOf('|');
    const model = (cut < 0 ? body : body.slice(0, cut)).trim();
    const vendor = (cut < 0 ? '' : body.slice(cut + 1)).trim();
    if (model || vendor) gpus.push({ model, vendor });
  }
  return gpus;
}

/**
 * 单次 PowerShell 探测 Windows 显卡。
 * 命令没跑成（失败、超时）时抛错并带上原因；跑成了但没有显卡返回 []。
 */
export async function probeWindowsGpus(
  run: RunCommand,
  systemRoot?: string,
  timeoutMs = WINDOWS_GPU_PROBE_TIMEOUT_MS,
): Promise<RawGpu[]> {
  const { file, args } = buildWindowsGpuProbeCommand(systemRoot);
  let output: string | null;
  try {
    output = await run(file, args, timeoutMs);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Windows GPU probe failed: ${reason}`);
  }
  if (output === null) {
    throw new Error('Windows GPU probe failed or timed out');
  }
  return parseWindowsGpuProbeOutput(output);
}

export interface GenericGpuDeps {
  platform: NodeJS.Platform;
  /** systeminformation.graphics()，只在非 Windows 平台使用 */
  siGraphics: () => Promise<{
    controllers?: Array<{ model?: string; vendor?: string }>;
  }>;
  run: RunCommand;
  /** Windows 的 %SystemRoot% */
  systemRoot?: string;
  /** 非 Windows 的 graphics() 超时，默认 10 秒 */
  timeoutMs?: number;
}

/**
 * 枚举显卡的名称与厂商。失败时抛错，由调用方决定降级（detectGpus 会退回 nvidia-smi 的结果）。
 */
export async function enumerateGenericGpus(
  deps: GenericGpuDeps,
): Promise<RawGpu[]> {
  if (deps.platform === 'win32') {
    return probeWindowsGpus(deps.run, deps.systemRoot);
  }

  const timeoutMs = deps.timeoutMs ?? 10_000;
  let timer: NodeJS.Timeout | undefined;
  try {
    const graphics = await Promise.race([
      deps.siGraphics(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('GPU detection timeout')),
          timeoutMs,
        );
      }),
    ]);
    return (graphics.controllers ?? [])
      .filter((controller) => controller.model || controller.vendor)
      .map((controller) => ({
        model: controller.model ?? '',
        vendor: controller.vendor ?? '',
      }));
  } finally {
    if (timer) clearTimeout(timer);
  }
}
