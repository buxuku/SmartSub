// 由 renderer/lib/jassub-worker-guard-loader.js 注入到 JASSUB Worker 入口的最前面，
// 导入即在 Worker 里装上守卫（原理见 ./syncCanvasGuard.ts）。
//
// 【诊断验证版的接线，不进正式版】先装诊断拦截器、再装正式的守卫：
// 拦截器因此在守卫里面、离原生 getContext 最近 —— 默认开关透传，默认路径 = 正式版（守卫生效）；
// 强制 true 会越过守卫，原生才真的收到 true（复现 3.9.0）；记录下来的也是原生真正收到的请求。
import { installDiagInterposer } from './diagInterposer';
import { installSyncCanvasGuard } from './syncCanvasGuard';

installDiagInterposer();
installSyncCanvasGuard();
