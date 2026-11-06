/**
 * webpack loader —— 在 JASSUB 的 Worker 入口（jassub/dist/worker/worker.js）最前面
 * 注入一行 `import "<guard>"`，让 renderer/lib/jassub/workerGuard.ts 先于任何渲染器执行。
 * 守卫做什么、为什么，见 renderer/lib/jassub/syncCanvasGuard.ts。
 *
 * 不加换行，保持上游源码的行号不变（便于对照 source map）。
 * 这条规则命中的是 node_modules 里的固定路径：上游一旦挪动 Worker 入口，规则就匹配不到，
 * 构建也不会报错——所以 renderer/lib/__tests__/jassubWorkerGuardWiring.test.ts 会拿真实的
 * jassub 包校验这个路径，请不要删掉那些用例。
 */
module.exports = function jassubWorkerGuardLoader(source) {
  const { guard } = this.getOptions();
  if (!guard) {
    throw new Error(
      '[jassub-worker-guard-loader] 缺少 `guard` 选项（守卫模块的绝对路径），请检查 renderer/next.config.js。',
    );
  }
  return `import ${JSON.stringify(guard)};${source}`;
};
