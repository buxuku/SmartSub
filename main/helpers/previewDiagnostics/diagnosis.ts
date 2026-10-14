/**
 * 把几层亮度读数翻译成一句人话，直接显示在诊断面板里，让测试的人当场就知道「这次测到了什么」。
 *
 * 读数（同一块视频区域）：
 *  - baseline：之前「画面正常」时测到的读数（用快捷键 F9 在鼠标放在视频上时采集）。
 *    用来排除「视频本身就是黑场」的误判——视频内容渲染进程读不出来（media:// 是跨源的，画布会被污染）；
 *  - viz：Chromium 合成器的输出（webContents.capturePage）；
 *  - os：Windows 桌面合成器（DWM）给出的最终画面，和肉眼、Win+Shift+S 截图同一层。
 *
 * 这只是第一眼的判断，不是结论；原始数字都在日志里。
 */

/** 只用到统计里的这一项：低于「几乎纯黑」阈值的采样占比。 */
export interface DarkStats {
  darkRatio: number;
}

/** darkRatio 达到它就认为「这一层是黑的」。字幕文字只占很小的面积，不会把它拉下来。 */
export const BLACK_RATIO = 0.97;
/** darkRatio 低于它就认为「这一层有内容」。 */
export const LIT_RATIO = 0.6;

export type ProbeVerdict =
  | 'present-layer-black'
  | 'compositor-black'
  | 'not-black'
  | 'inconclusive';

export interface ProbeInput {
  baseline: DarkStats | null;
  viz: DarkStats | null;
  os: DarkStats | null;
}

export interface ProbeVerdictResult {
  verdict: ProbeVerdict;
  text: string;
}

const isBlack = (stats: DarkStats | null) =>
  stats !== null && stats.darkRatio >= BLACK_RATIO;
const isLit = (stats: DarkStats | null) =>
  stats !== null && stats.darkRatio <= LIT_RATIO;

const NO_BASELINE =
  '（还没有「画面正常」的基线：若视频此刻本身是黑场，这条判断无效。可把鼠标放在视频上，按 F9 采集基线。）';

export function interpretProbe(input: ProbeInput): ProbeVerdictResult {
  const { baseline, viz, os } = input;
  if (isBlack(baseline)) {
    return {
      verdict: 'inconclusive',
      text: '「画面正常」的基线本身就是黑的（片头黑场或视频没有画面），无法对比。请把进度拖到有明显画面的位置，重新按 F9 采集基线。',
    };
  }
  const caveat = baseline === null ? NO_BASELINE : '';
  if (os === null) {
    if (isBlack(viz)) {
      return {
        verdict: 'compositor-black',
        text: `合成器截图是黑的：黑屏发生在 Chromium 合成之前或之中。（系统层没测到）${caveat}`,
      };
    }
    return {
      verdict: 'inconclusive',
      text: '没有取到系统层画面，只凭合成器截图无法判断（合成器层看起来正常）。',
    };
  }
  if (isBlack(os) && isLit(viz)) {
    return {
      verdict: 'present-layer-black',
      text: '系统层是黑的，但合成器认为画面正常：问题出在最后的呈现层（DirectComposition / 多平面叠加 / 显卡驱动）。',
    };
  }
  if (isBlack(os) && isBlack(viz)) {
    return {
      verdict: 'compositor-black',
      text: `合成器和系统层都是黑的：问题出在 Chromium 合成之前或之中（渲染层 / GPU 进程）。${caveat}`,
    };
  }
  if (isLit(os)) {
    return {
      verdict: 'not-black',
      text: '系统层画面有内容：此刻并不是黑屏状态。',
    };
  }
  return {
    verdict: 'inconclusive',
    text: '读数介于黑与正常之间，无法判断，请把诊断包发给开发者。',
  };
}
