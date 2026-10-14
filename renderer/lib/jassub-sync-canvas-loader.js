/**
 * webpack loader —— 规避 Windows 上「视频合成」预览整块变黑（3.9.0 引入 JASSUB 后出现）。
 *
 * 根因：jassub 的三个渲染器（WebGL2 / WebGL1 / 2D）在 Worker 里用 `desynchronized: true`
 * 创建画布上下文，即「低延迟画布」。Windows 上 Chromium 会把这种无遮挡的低延迟画布
 * 提升为独立的 DirectComposition 叠加层（与 <video> 的叠加层覆盖同一块区域）。在走软件
 * 叠加层的显卡上（chrome://gpu 的 overlayInfo 全为 SOFTWARE，常见于 NVIDIA 与虚拟显卡），
 * 这一层最终呈现为纯黑：合成器截图（capturePage）正常，而 OS 呈现层截图整块全 0；
 * 鼠标离开视频区后叠加层数 2→3，随即整块黑屏（暂停/播放皆然，进度条也被盖住）。
 * 真机实测：只把 desynchronized 改为 false，叠加层数恒为 2，黑屏消失。
 * 上游 jassub 直到 2.5.20 仍写死 true，且没有暴露该选项，所以只能在构建期改写。
 *
 * 做法：仅在 Windows 改为 false，其它平台保持上游行为不变。判定在 Worker 内按
 * navigator.userAgent 进行（Windows 版 Chromium / Electron 的 UA 恒含 "Windows NT"）。
 * 代价：字幕画布不再走低延迟呈现，而是与页面同步合成——对编辑预览没有可感知的影响。
 *
 * 若上游改了写法或不再写死，本 loader 会让构建直接失败（而不是悄悄失效），
 * 届时请复核并删除 renderer/next.config.js 里的这条规则。
 */
const DESYNC_TRUE = /\bdesynchronized\s*:\s*true\b/g;

// 非 Windows（或拿不到 navigator）时保持上游的 true。
const DESYNC_UNLESS_WINDOWS =
  "desynchronized: !/Windows/.test(globalThis.navigator?.userAgent ?? '')";

module.exports = function jassubSyncCanvasLoader(source) {
  let replaced = 0;
  const output = source.replace(DESYNC_TRUE, () => {
    replaced += 1;
    return DESYNC_UNLESS_WINDOWS;
  });
  if (replaced === 0) {
    throw new Error(
      `[jassub-sync-canvas-loader] ${this.resourcePath} 中没有找到 \`desynchronized: true\`。` +
        '上游 jassub 可能已修改或修复该行为，请复核并删除 renderer/next.config.js 里对应的规则。',
    );
  }
  return output;
};
