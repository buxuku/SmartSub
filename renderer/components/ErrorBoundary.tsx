import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * 顶层渲染错误边界：任一页面/向导抛出未捕获渲染异常时，
 * 显示可恢复的兜底界面而不是整个应用白屏。
 * 文案不走 i18n——翻译层本身也可能是崩溃源，兜底 UI 保持零依赖。
 */
export default class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('Uncaught render error:', error, info.componentStack);
  }

  private handleReload = () => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-background p-8 text-foreground">
        <h1 className="text-lg font-semibold">
          页面出错了 / Something went wrong
        </h1>
        <p className="max-w-md break-all text-center text-sm text-muted-foreground">
          {this.state.error.message}
        </p>
        <button
          type="button"
          onClick={this.handleReload}
          className="rounded-md border border-border bg-secondary px-4 py-2 text-sm hover:bg-secondary/80"
        >
          重新加载 / Reload
        </button>
      </div>
    );
  }
}
