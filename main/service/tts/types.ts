export interface TtsSynthesizeInput {
  text: string;
  /** 输出 wav 路径（16-bit PCM，供对齐管线读取）。 */
  outWavPath: string;
  signal?: AbortSignal;
}

export interface TtsTestResult {
  ok: boolean;
  status?: number;
  needsConfig?: boolean;
  detail?: string;
}
