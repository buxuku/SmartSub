/**
 * 硬件编码器运行时探测（合成硬件加速用）
 *
 * 用「带目标画质参数的黑帧试编码」做真实能力探测，而非仅看 ffmpeg 编码器列表
 * （Windows 构建三家硬件编码器永远在列表里，能否真跑取决于用户显卡+驱动）或
 * 嗅探平台/CPU 架构（Intel Mac / Rosetta 等场景嗅探不可靠）。
 * 结果按进程会话缓存，不持久化（避免用户换显卡/升驱动后缓存过期）。
 */

import ffmpegStatic from 'ffmpeg-static';
import { execFile } from 'child_process';
import { logMessage } from './logger';
import type {
  HwAccelInfo,
  HwEncoderId,
  HwRateMode,
} from '../../types/subtitleMerge';
import { HW_QUALITY_MAPPING } from '../../types/subtitleMerge';

const ffmpegPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');

export const HW_ENCODER_LABELS: Record<HwEncoderId, string> = {
  h264_videotoolbox: 'VideoToolbox',
  h264_nvenc: 'NVIDIA NVENC',
  h264_qsv: 'Intel QSV',
};

/** 试编码正常亚秒级完成；超时兜底驱动挂起等异常 */
const PROBE_TIMEOUT_MS = 15000;

/** 640x360 黑帧 0.1s：避开 NVENC 最小分辨率限制，编码量可忽略 */
const PROBE_INPUT_ARGS = [
  '-hide_banner',
  '-f',
  'lavfi',
  '-i',
  'color=black:s=640x360:d=0.1',
];

/** 与正式合成路径一致：字幕滤镜后统一转 8-bit 4:2:0（此处仅对齐参数形状） */
const PROBE_FORMAT_ARGS = ['-vf', 'format=nv12'];

/**
 * 恒定质量试编码参数（与正式合成同形状，取 high 档值；
 * 探测关心的是「参数是否被接受」，具体数值不影响结论）
 */
export function buildHwCqArgs(encoderId: HwEncoderId, cq: number): string[] {
  switch (encoderId) {
    case 'h264_nvenc':
      return [
        '-c:v',
        'h264_nvenc',
        '-rc',
        'vbr',
        '-cq',
        String(cq),
        '-b:v',
        '0',
        '-preset',
        'p5',
      ];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-global_quality', String(cq)];
    case 'h264_videotoolbox':
      return [
        '-c:v',
        'h264_videotoolbox',
        '-q:v',
        String(cq),
        '-realtime',
        '0',
      ];
  }
}

/** VT 码率模式参数（Intel Mac：VideoToolbox 不支持 -q:v 时的降级路径） */
export function buildVtBitrateArgs(
  bitrate: number,
  maxrate: number,
  bufsize: number,
): string[] {
  return [
    '-c:v',
    'h264_videotoolbox',
    '-b:v',
    String(bitrate),
    '-maxrate',
    String(maxrate),
    '-bufsize',
    String(bufsize),
    '-realtime',
    '0',
  ];
}

/** 提取 stderr 最后一行非空内容（探测失败原因日志用） */
function lastStderrLine(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return (lines[lines.length - 1] || '').slice(0, 300);
}

function probeEncode(
  encodeArgs: string[],
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      ffmpegPath,
      [
        ...PROBE_INPUT_ARGS,
        ...PROBE_FORMAT_ARGS,
        ...encodeArgs,
        '-f',
        'null',
        '-',
      ],
      { timeout: PROBE_TIMEOUT_MS },
      (err, _stdout, stderr) => {
        resolve({ ok: !err, stderr: String(stderr || '') });
      },
    );
  });
}

/**
 * 探测单个编码器：先恒定质量参数，VT 失败再码率参数（Intel Mac）；
 * NVENC/QSV 恒定质量失败即视为不可用（第一期不为其开码率分支）。
 */
async function detectEncoder(
  encoderId: HwEncoderId,
): Promise<{ rateMode: HwRateMode } | null> {
  const cqValue = HW_QUALITY_MAPPING[encoderId].cq.high;
  const cqResult = await probeEncode(buildHwCqArgs(encoderId, cqValue));
  if (cqResult.ok) {
    return { rateMode: 'cq' };
  }
  logMessage(
    `硬件编码器试编码失败(恒定质量) ${encoderId}: ${lastStderrLine(cqResult.stderr)}`,
    'info',
  );

  if (encoderId === 'h264_videotoolbox') {
    const brResult = await probeEncode(
      buildVtBitrateArgs(2_000_000, 3_000_000, 4_000_000),
    );
    if (brResult.ok) {
      return { rateMode: 'bitrate' };
    }
    logMessage(
      `硬件编码器试编码失败(码率模式) ${encoderId}: ${lastStderrLine(brResult.stderr)}`,
      'info',
    );
  }
  return null;
}

/** 平台候选编码器（优先级序）；Linux 打包的静态 ffmpeg 无硬件编码器，本期不支持 */
function platformCandidates(): HwEncoderId[] {
  if (process.platform === 'darwin') return ['h264_videotoolbox'];
  if (process.platform === 'win32') return ['h264_nvenc', 'h264_qsv'];
  return [];
}

async function runDetection(): Promise<HwAccelInfo> {
  const candidates = platformCandidates();
  if (candidates.length === 0) {
    logMessage(
      '当前平台不支持合成硬件加速（打包 ffmpeg 无硬件编码器）',
      'info',
    );
    return { available: false, platformSupported: false };
  }

  const started = Date.now();
  for (const encoderId of candidates) {
    const result = await detectEncoder(encoderId);
    if (result) {
      logMessage(
        `硬件编码器探测完成(${Date.now() - started}ms): ${encoderId} / ${result.rateMode}`,
        'info',
      );
      return {
        available: true,
        encoderId,
        encoderLabel: HW_ENCODER_LABELS[encoderId],
        rateMode: result.rateMode,
        platformSupported: true,
      };
    }
  }
  logMessage(
    `硬件编码器探测完成(${Date.now() - started}ms): 无可用编码器`,
    'info',
  );
  return { available: false, platformSupported: true };
}

// Promise 缓存：并发请求共享同一次探测，结果保留整个会话
let cachedDetection: Promise<HwAccelInfo> | null = null;

/** 获取硬件编码器探测结果（首次调用触发探测，之后命中缓存） */
export function getHwAccelInfo(): Promise<HwAccelInfo> {
  if (!cachedDetection) {
    cachedDetection = runDetection().catch((err) => {
      // runDetection 内部不 reject；兜底意外异常，不缓存坏状态
      logMessage(`硬件编码器探测异常: ${err}`, 'warning');
      cachedDetection = null;
      return {
        available: false,
        platformSupported: platformCandidates().length > 0,
      };
    });
  }
  return cachedDetection;
}
