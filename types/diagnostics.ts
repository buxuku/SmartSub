/**
 * 诊断包（导出崩溃排查资料）在主进程与渲染进程之间传递的类型。
 */

export interface DiagnosticsDumpPreview {
  /** 转储文件名（不含目录） */
  name: string;
  size: number;
  mtimeMs: number;
  /** 摘要里的异常名，如 ILLEGAL_INSTRUCTION；读不出来为 null */
  exception: string | null;
  /** 摘要里的故障模块名，如 addon.node；读不出来为 null */
  faultModule: string | null;
}

/** 导出前给用户看的“包里会有什么”。 */
export interface DiagnosticsPreview {
  logDays: number;
  logBytes: number;
  crashEventCount: number;
  dumps: DiagnosticsDumpPreview[];
  dumpBytes: number;
  /** 崩溃转储是否在记录（被环境变量关闭时为 false） */
  crashReporterEnabled: boolean;
  suggestedFileName: string;
}

export interface DiagnosticsExportRequest {
  /** 是否附带原始 .dmp（可能含崩溃时的内存片段，默认不带） */
  includeRawDumps: boolean;
}

export interface DiagnosticsExported {
  ok: true;
  filePath: string;
  bytes: number;
  rawDumps: number;
  /** 某一部分收集失败时的说明；包仍然会生成 */
  warnings: string[];
}

export interface DiagnosticsExportFailed {
  ok: false;
  /** 用户在保存对话框里取消了 */
  canceled?: boolean;
  error?: string;
}

export type DiagnosticsExportResult =
  | DiagnosticsExported
  | DiagnosticsExportFailed;

/** 渲染进程未开 strict，布尔字面量的判别联合不会自动收窄，用类型守卫。 */
export function isDiagnosticsExported(
  result: DiagnosticsExportResult,
): result is DiagnosticsExported {
  return result.ok === true;
}

export type PreviousRunEvidenceKind = 'dump' | 'in-flight' | 'event';

/**
 * 上次运行异常结束、并且找到了崩溃证据时，给用户看的一次性提示的内容。
 * 只有“没走完退出流程”本身不足以提示（强杀、安装程序关闭、断电都会这样）。
 */
export interface PreviousRunNotice {
  /** 大致发生时间（毫秒时间戳）：取最新一条证据的时间 */
  at: number;
  evidence: PreviousRunEvidenceKind[];
  /** 分类，例如 illegal-instruction、access-violation；没有可归类的异常时缺省 */
  kind?: string;
  /** 简短标签，例如 ILLEGAL_INSTRUCTION */
  label?: string;
  /** 转储里的出错模块，例如 addon.node */
  faultModule?: string;
  /** 崩溃时正在运行的引擎与后端（来自在途标记或崩溃事件的现场） */
  engine?: string;
  backend?: string;
  /** 因这次崩溃而被自动停用的加速后端（没有停用任何后端时缺省） */
  suppressed?: PreviousRunSuppressed[];
}

export interface PreviousRunSuppressed {
  /** family：整个预编译加速包族（CPU 指令集不满足）；candidate：单个后端 */
  scope: 'family' | 'candidate';
  /** isa：CPU 指令集不满足；crash：其他崩溃 */
  reason: 'isa' | 'crash';
  /** 候选键，例如 builtin:vulkan（不含路径） */
  key: string;
}

/** 设置页展示的“已被自动停用的后端”。 */
export interface SuppressedBackendInfo {
  scope: 'family' | 'candidate';
  key: string;
  reason: 'isa' | 'crash';
  /** strong：转储证明崩了；weak：连续异常退出时都在用它 */
  evidence: 'strong' | 'weak';
  since: number;
  detail?: string;
}
