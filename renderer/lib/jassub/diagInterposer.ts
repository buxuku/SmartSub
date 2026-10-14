/**
 * 诊断验证版专用（不进正式版）：装在 JASSUB Worker 里的 OffscreenCanvas.prototype.getContext 拦截器。
 *
 * 它要同时做到两件事：
 *  - 诊断开关为默认值时原样透传 —— 于是默认路径 = 正式版（Windows 下由守卫把 desynchronized 压成 false）；
 *  - 诊断面板要求「强制 true / false」时覆盖渲染器的请求，用来在同一个安装包里复现 3.9.0 的黑屏做对照。
 * 并记录渲染器「最终」交给原生 getContext 的属性（requestedAttributes，由 patch-jassub 的上下文回报带出）。
 *
 * 装的顺序决定了能不能强制 true：必须先装本拦截器、再装守卫（见 ./workerGuard.ts），
 * 拦截器才在守卫里面、离原生最近，强制值不会被守卫改回去，记录的也才是原生真正收到的。
 * 诊断开关由 Worker 的 init 消息带来（patch-jassub 把它放进 globalThis.__SMARTSUB_JASSUB_DIAG__），
 * 比模块执行晚，所以每次调用时才读取。
 */
const INSTALLED: unique symbol = Symbol.for('smartsub.diagInterposer');

type GetContext = (
  this: unknown,
  type?: string,
  attrs?: unknown,
  ...rest: unknown[]
) => unknown;
type MarkedGetContext = GetContext & { [INSTALLED]?: true };

export interface DiagScope {
  OffscreenCanvas?: {
    prototype: {
      getContext(
        this: unknown,
        type?: string,
        attrs?: unknown,
        ...rest: unknown[]
      ): unknown;
    };
  };
  __SMARTSUB_JASSUB_DIAG__?: Record<string, unknown>;
  __SMARTSUB_JASSUB_REQUESTS__?: Array<Record<string, unknown>>;
}

export function installDiagInterposer(
  scope: DiagScope = globalThis as unknown as DiagScope,
): boolean {
  const proto = scope.OffscreenCanvas?.prototype;
  if (!proto) return false;
  const original = proto.getContext as MarkedGetContext;
  if (original[INSTALLED]) return false;

  const requests: Array<Record<string, unknown>> = [];
  scope.__SMARTSUB_JASSUB_REQUESTS__ = requests;

  const interposed: MarkedGetContext = function (
    this: unknown,
    type,
    attrs,
    ...rest
  ) {
    const diag = scope.__SMARTSUB_JASSUB_DIAG__ ?? {};
    let next = attrs;
    // 只处理带属性对象的调用（JASSUB 的探测调用 getContext('webgl2') 不带属性）。
    if (attrs && typeof attrs === 'object') {
      const requested = attrs as Record<string, unknown>;
      // 只覆盖渲染器本来就带了的键（2D 上下文没有 powerPreference，不凭空添加），且不改动原对象。
      const forceDesync =
        diag.desynchronized !== undefined && 'desynchronized' in requested;
      const forcePower =
        diag.powerPreference !== undefined && 'powerPreference' in requested;
      if (forceDesync || forcePower) {
        const copy = { ...requested };
        if (forceDesync) copy.desynchronized = diag.desynchronized;
        if (forcePower) copy.powerPreference = diag.powerPreference;
        next = copy;
      }
      const sent = next as Record<string, unknown>;
      requests.push({
        type,
        desynchronized: sent.desynchronized,
        powerPreference: sent.powerPreference,
      });
    }
    return original.call(this, type, next, ...rest);
  };
  interposed[INSTALLED] = true;
  proto.getContext = interposed;
  return true;
}
