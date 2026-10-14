/**
 * 视频区右上角的时钟（诊断用，默认不显示）。
 *
 * 它是视频容器里的一块普通 DOM，每 100ms 直接改文字（不经过 React 渲染）。
 * 黑屏时它还看得见 ⇒ 黑的只是视频 / 画布层；它也消失了 ⇒ 整个容器的 DOM 都没有被呈现。
 * 它在视频之上（z-30），所以也等于在问「视频之上的东西为什么也看不见」。
 */
import React, { useEffect, useRef } from 'react';

export default function PreviewDiagMarker() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const update = () => {
      const el = ref.current;
      if (!el) return;
      const now = new Date();
      el.textContent = `${now.toLocaleTimeString()}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    };
    update();
    const timer = setInterval(update, 100);
    return () => clearInterval(timer);
  }, []);
  return (
    <div
      ref={ref}
      data-diag-marker
      className="pointer-events-none absolute right-1 top-1 z-30 rounded bg-fuchsia-600 px-1.5 py-0.5 font-mono text-[11px] text-white"
    />
  );
}
