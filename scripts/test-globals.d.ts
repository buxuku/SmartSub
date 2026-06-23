/**
 * 测试专用全局声明（仅供 scripts/test-engine-units.ts 的 tsc 编译使用）。
 *
 * 纯逻辑测试现在会通过 renderer/lib/engineModels → renderer/lib/utils 间接引入
 * `window.ipc`，而该全局类型由 renderer/preload.d.ts 声明（其又 import 了
 * main/preload，会牵连 electron）。为保持测试无 electron 依赖，这里给出最小化的
 * 结构化兜底声明，避免把 preload.d.ts/electron 拖进测试编译。
 */
interface Window {
  // 形状对齐 main/preload.ts 的 IpcHandler（invoke 返回 Promise<any>），
  // 避免该兜底声明被根 tsconfig 扫到后把渲染层 window.ipc 调用误判为 unknown。
  ipc: {
    send: (channel: string, value?: unknown) => void;
    invoke: (channel: string, ...args: unknown[]) => Promise<any>;
    getPathForFile: (file: File) => string;
    on: (
      channel: string,
      callback: (...args: any[]) => void,
    ) => (() => void) | undefined;
    platform: string;
  };
}
