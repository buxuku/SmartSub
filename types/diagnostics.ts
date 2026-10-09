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
