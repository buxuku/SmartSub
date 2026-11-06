// 由 renderer/lib/jassub-worker-guard-loader.js 注入到 JASSUB Worker 入口的最前面，
// 导入即在 Worker 里装上守卫（原理见 ./syncCanvasGuard.ts）。
import { installSyncCanvasGuard } from './syncCanvasGuard';

installSyncCanvasGuard();
