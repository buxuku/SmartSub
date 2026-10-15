/**
 * 规避 Windows 上「视频合成」预览整块变黑（3.9.0 引入 JASSUB 后出现）。
 *
 * 根因：JASSUB 在 Worker 里用 `desynchronized: true`（低延迟画布）创建 WebGL2 / WebGL1 / 2D
 * 上下文，上游写死且没有暴露该选项（截至 2.5.20）。上游 issue #70
 * （https://github.com/ThaUnknown/jassub/issues/70，标题即 "desynchronized: true causes black
 * background/rendering artifacts on Windows"，报告者是 NVIDIA 笔记本，与这里的 VMware 虚拟机
 * 是两类不同的环境）报告的是同一个开关在 Windows 上引起的黑底 / 渲染异常，维护者不会改默认值。
 *
 * 机制（1、2、4 来自 Chromium 124 即 Electron 30 的源码，3 里「呈现为黑」的那一步是推断；
 * 整体由下面的真机 A/B 对照支持）：
 *  1. WebGL 上下文带 desynchronized 时，Windows 上改用 DXGI 交换链出图，这块画布因此成为
 *     DirectComposition 叠加层的候选（blink 的 drawing_buffer.cc：is_overlay_candidate 含
 *     using_swap_chain_）。
 *  2. 候选只有在「它上方没有任何已绘制的内容」时才会真的被提升成叠加层；一旦被盖住，带 alpha 的
 *     画布不能当 underlay，退回普通合成（viz 的 dc_layer_overlay.cc：IsOccluded / IsUnderlayAllowed）。
 *     预览里唯一盖在字幕画布上方的是 SubtitleCanvas 的拖拽手柄：平时 opacity-0，鼠标进入预览区才
 *     显示，没有字幕文字时更是根本不渲染。所以「鼠标移到左侧面板 / 暂停 / 播放 / 当前无字幕」时
 *     画布被提升，这正是 3.9.0 现象的触发条件。
 *  3. 在叠加层只有软件实现的环境（复现机为 VMware SVGA 虚拟显卡，chrome://gpu 的 overlayInfo
 *     各格式全为 SOFTWARE）里，被提升的这一层呈现为纯黑，连 <video> 的原生进度条一起盖住：合成器
 *     截图（capturePage）正常，OS 呈现层截图整块全 0；鼠标离开视频区后叠加层数 2→3。
 *  4. OffscreenCanvas 的 2D 上下文不会因为 desynchronized 走交换链：offscreen_canvas.cc 的资源
 *     提供者没有低延迟分支，只有 HTMLCanvasElement 的 2D 才有（canvas_rendering_context_host.cc）。
 *
 * 真机（Win11 / VMware 虚拟机）A/B：只把 desynchronized 强制回 true 就复现黑屏，换回随正式版
 * （即本守卫）立刻恢复；渲染后端改成 2D，或在字幕画布上方常驻一个时钟元素，即使强制 true 也不黑
 * ——与上面的机制一致：守卫去掉的是触发条件本身（交换链），不依赖画布上方有没有东西。
 *
 * 做法：不改动 JASSUB，也不改它的默认值——在它的 Worker 里包装 OffscreenCanvas.prototype.getContext，
 * 仅在 Windows 把「请求 desynchronized」改成「不请求」。上下文属性在第一次 getContext 之后
 * 就不可更改，且画布是交给 Worker 创建上下文的，所以只能在 Worker 内、创建的那一刻拦截。
 * 这个模块由 renderer/lib/jassub-worker-guard-loader.js 注入到 JASSUB Worker 入口的最前面，
 * 因此先于任何渲染器执行；Worker 只在合成预览存在时才会被创建，影响面仅限于它。
 * 注入只对 JASSUB 默认的 Worker 入口（dist/worker/worker.js）有效：应用若给 JASSUB 传了自定义的
 * workerUrl，实际运行的 Worker 碰不到这条注入，守卫就不会装上。目前应用不传，
 * renderer/lib/__tests__/jassubWorkerGuardWiring.test.ts 里有用例盯着。
 *
 * 规则一旦匹配不到，构建不会报错，守卫就悄悄没了，所以「它真的在生效」分三层检查：
 *  - 单测（上面那个 wiring 测试）：规则命中 jassub 真实的 Worker 入口，应用不传自定义 workerUrl；
 *  - 构建后检查（scripts/check-jassub-worker-guard.mjs，CI 在 yarn build 之后运行）：产物里确实带着守卫；
 *  - e2e（scripts/e2e/compose-sync-canvas.mjs，手动运行）：守卫在 Worker 里先于渲染器执行，
 *    交给原生 getContext 的属性里没有 desynchronized: true。
 *
 * 其它平台保持上游行为不变（问题只在 Windows 上观察到，门禁只是把改动面压到最小）。
 * 代价：字幕画布不再走低延迟呈现，而是与页面同步合成——对编辑预览没有可感知的影响。
 *
 * 为什么不换成别的办法（别因为「看起来更简单」而改掉它）：
 *  - 强制 JASSUB 用 2D 渲染器：JASSUB 没有这个选项，要补丁或同样拦截 getContext 才行；还丢掉
 *    GPU 合成，并且依赖上面第 4 条这个 Chromium 实现细节，换版本就可能失效。
 *  - 在字幕画布上方常驻一个元素，或给祖先加近似恒等的 CSS filter（上游社区的绕法）：靠合成器的
 *    遮挡 / 分层启发式「碰巧」避开提升，取决于布局状态和 Chromium 版本，画布仍是交换链出图——
 *    这也正是本问题时有时无的原因（本项目的验证里只测过它与其它缓解项一起开，没单独验证）。
 *  - 换掉 JASSUB：@jellyfin/libass-wasm 用 2D 画布、不请求 desynchronized，确实没有这个问题，
 *    但没有 WebGL、API 也不同（预览依赖 manualRender / addFonts / setTrack / getEvents 等 JASSUB 专有
 *    接口），要重写预览管线并重测字体和性能，改动面远大于一个 getContext 守卫。留作兜底。
 *
 * 上游若提供了该选项或修复了问题，请把整套一起删掉：renderer/next.config.js 里对应的规则、本目录、
 * renderer/lib/jassub-worker-guard-loader.js、scripts/check-jassub-worker-guard.mjs 和
 * scripts/e2e/compose-sync-canvas.mjs，以及它们的单测（renderer/lib/__tests__/jassubWorkerGuard*）、
 * package.json 里的 check:jassub-guard / test:e2e:compose-sync-canvas 和 ci.yml 里对应的步骤。
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
