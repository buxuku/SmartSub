/**
 * 下载会话所有权跟踪器。旧异步回调只能结束自己创建的会话，不能清掉随后
 * 启动的新会话；用于防止「取消后立即重试」的 stale-finally 串扰。
 */
export class DownloadSessionTracker {
  private nextId = 0;
  private activeId: number | null = null;

  begin(): number {
    const id = ++this.nextId;
    this.activeId = id;
    return id;
  }

  owns(id: number): boolean {
    return this.activeId === id;
  }

  finish(id: number): boolean {
    if (!this.owns(id)) return false;
    this.activeId = null;
    return true;
  }
}
