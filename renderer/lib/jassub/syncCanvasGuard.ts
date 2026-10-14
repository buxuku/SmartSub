/**
 * 规避 Windows 上「视频合成」预览整块变黑（3.9.0 引入 JASSUB 后出现）。
 *
 * 根因：JASSUB 在 Worker 里用 `desynchronized: true`（低延迟画布）创建 WebGL2 / WebGL1 / 2D
 * 上下文，上游写死且没有暴露该选项（截至 2.5.20）。Windows 上 Chromium 会把这种无遮挡的
 * 低延迟画布提升为独立的 DirectComposition 叠加层，与 <video> 的叠加层覆盖同一块区域。
 * 在只提供软件叠加层的显卡上（NVIDIA、虚拟显卡等，chrome://gpu 的 overlayInfo 全为 SOFTWARE），
 * 这一层最终呈现为纯黑：合成器截图（capturePage）正常，而 OS 呈现层截图整块全 0；
 * 鼠标离开视频区后叠加层数 2→3，随即整块黑屏（暂停/播放皆然，进度条也被盖住）。
 * 真机实测：只把 desynchronized 改为 false，叠加层数恒为 2，黑屏消失。
 * 上游对此的态度见 https://github.com/ThaUnknown/jassub/issues/70（维护者不会改默认值）。
 *
 * 做法：不改动 JASSUB，也不改它的默认值——在它的 Worker 里包装 OffscreenCanvas.prototype.getContext，
 * 仅在 Windows 把「请求 desynchronized」改成「不请求」。上下文属性在第一次 getContext 之后
 * 就不可更改，且画布是交给 Worker 创建上下文的，所以只能在 Worker 内、创建的那一刻拦截。
 * 这个模块由 renderer/lib/jassub-worker-guard-loader.js 注入到 JASSUB Worker 入口的最前面，
 * 因此先于任何渲染器执行；Worker 只在合成预览存在时才会被创建，影响面仅限于它。
 *
 * 其它平台保持上游行为不变（那里的 Chromium 本来就忽略这个提示，门禁只是把改动面压到最小）。
 * 代价：字幕画布不再走低延迟呈现，而是与页面同步合成——对编辑预览没有可感知的影响。
 *
 * 上游若提供了该选项或修复了问题，请删除 renderer/next.config.js 里对应的规则连同本目录。
 */

// 其它代码（例如 e2e）可以用它判断 Worker 里是否已装上守卫。
export const SYNC_CANVAS_GUARD: unique symbol = Symbol.for(
  'smartsub.syncCanvasGuard',
);

type GetContext = (
  this: unknown,
  contextId?: string,
  attributes?: unknown,
  ...rest: unknown[]
) => unknown;
type GuardedGetContext = GetContext & { [SYNC_CANVAS_GUARD]?: true };

export interface GuardScope {
  OffscreenCanvas?: {
    prototype: {
      getContext(
        this: unknown,
        contextId?: string,
        attributes?: unknown,
        ...rest: unknown[]
      ): unknown;
    };
  };
  navigator?: { userAgent?: string };
}

// Windows 版 Chromium / Electron 的 UA 恒含 "Windows NT"。
const isWindows = (scope: GuardScope) =>
  /Windows/.test(scope.navigator?.userAgent ?? '');

// 只有真的请求了 desynchronized 才复制一份改掉；其余原样转交，也从不改调用方传入的对象。
function withoutDesynchronized(attributes: unknown): unknown {
  if (
    attributes &&
    typeof attributes === 'object' &&
    (attributes as { desynchronized?: unknown }).desynchronized
  ) {
    return { ...attributes, desynchronized: false };
  }
  return attributes;
}

/**
 * 在当前（Worker）全局作用域里装上守卫。返回是否真的装上了：
 * 非 Windows、没有 OffscreenCanvas、或已经装过，都返回 false 且不做任何改动。
 */
export function installSyncCanvasGuard(
  scope: GuardScope = globalThis as unknown as GuardScope,
): boolean {
  const proto = scope.OffscreenCanvas?.prototype;
  if (!proto || !isWindows(scope)) return false;

  const original = proto.getContext as GuardedGetContext;
  if (original[SYNC_CANVAS_GUARD]) return false;

  const guarded: GuardedGetContext = function (
    this: unknown,
    contextId,
    attributes,
    ...rest
  ) {
    return original.call(
      this,
      contextId,
      withoutDesynchronized(attributes),
      ...rest,
    );
  };
  guarded[SYNC_CANVAS_GUARD] = true;
  proto.getContext = guarded;
  return true;
}
