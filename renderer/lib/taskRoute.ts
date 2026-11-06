/**
 * 任务页「路由 → 工程」的装载判定。
 *
 * 路由（任务类型 + ?project=）变化后，页面要重新装载工程；装载完成前整页显示加载态。
 * 但首次自动保存后，页面会自己 router.replace 把 ?project=<当前工程> 补进 URL——
 * 这只是 URL 追上了已装载的工程，并不是切换路由。若此刻也退回整页加载态，
 * 配置条、文件列表整棵树会被卸载重建，已打开的弹层（词库、翻译服务等本地状态）随之被关掉。
 */
export function taskRouteKey(slug: string, project: string): string {
  return `${slug}:${project}`;
}

export function isTaskRouteHydrated({
  hydratedRoute,
  slug,
  queryProject,
  projectId,
}: {
  /** 上一次装载完成时的路由键；未装载过为 null */
  hydratedRoute: string | null;
  slug: string;
  /** 当前 URL 的 ?project=，没有则为空串 */
  queryProject: string;
  /** 当前已装载的工程 ID */
  projectId: string | null;
}): boolean {
  if (hydratedRoute === taskRouteKey(slug, queryProject)) return true;
  // 新建任务（URL 无 project）装载后，URL 被补上的正是这个工程：视为已装载。
  return (
    queryProject !== '' &&
    queryProject === projectId &&
    hydratedRoute === taskRouteKey(slug, '')
  );
}
