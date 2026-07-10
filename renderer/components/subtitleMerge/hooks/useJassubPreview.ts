/**
 * JASSUB（libass WASM）字幕预览引擎 hook。
 *
 * 预览与烧录消费同一份主进程生成的 ASS 内容（subtitleMerge:buildPreviewAss），
 * 同一渲染引擎（libass）保证字号、换行、背景框、描边、阴影所见即所得。
 * 引擎初始化失败时置 failed=true，由调用方回退 CSS 模拟预览。
 */

import { useEffect, useRef, useState } from 'react';
import type JASSUB from 'jassub';
import type { SubtitleStyle } from '../../../../types/subtitleMerge';

interface UseJassubPreviewOptions {
  /** 视频元素（ReactPlayer onReady 后取 getInternalPlayer），无视频时为 null */
  videoEl: HTMLVideoElement | null;
  /** 已选字幕文件路径（无则用 sampleText 生成全程显示的样例字幕） */
  subtitlePath?: string | null;
  /** 样例文字（未选字幕文件时调样式用） */
  sampleText?: string;
  /** 当前字幕样式 */
  style: SubtitleStyle;
}

interface UseJassubPreviewResult {
  /** 引擎已就绪并正在渲染（调用方应隐藏 CSS 模拟叠加层） */
  active: boolean;
  /** 引擎初始化失败（调用方应回退 CSS 模拟叠加层） */
  failed: boolean;
}

/** 更新预览的防抖间隔：ASS 重新生成 + setTrack 为毫秒级操作，200ms 足够平滑 */
const UPDATE_DEBOUNCE_MS = 200;

/**
 * 强制立即重绘当前帧。
 * JASSUB 依赖 requestVideoFrameCallback，只在视频呈现新帧（播放/拖动）时重绘；
 * 暂停状态下换轨/改样式后必须手动触发一次渲染，否则要拖动进度条才能看到效果。
 */
function forceRepaint(instance: JASSUB, video: HTMLVideoElement): void {
  if (!video.videoWidth || !video.videoHeight) return;
  instance.manualRender(
    {
      mediaTime: video.currentTime,
      width: video.videoWidth,
      height: video.videoHeight,
      expectedDisplayTime: performance.now(),
    },
    true,
  );
}

async function fetchPreviewAss(
  subtitlePath: string | null | undefined,
  sampleText: string | undefined,
  style: SubtitleStyle,
): Promise<string | null> {
  const res = await window.ipc.invoke('subtitleMerge:buildPreviewAss', {
    subtitlePath: subtitlePath || null,
    sampleText,
    style,
  });
  return res?.success ? (res.data as string) : null;
}

async function fetchFontData(
  fontName: string,
): Promise<{ fontName: string; data: Uint8Array } | null> {
  try {
    const res = await window.ipc.invoke('subtitleMerge:getFontData', {
      fontName,
    });
    if (!res?.success) return null;
    return {
      fontName: res.data.fontName as string,
      data: new Uint8Array(res.data.data),
    };
  } catch {
    return null;
  }
}

export function useJassubPreview({
  videoEl,
  subtitlePath,
  sampleText,
  style,
}: UseJassubPreviewOptions): UseJassubPreviewResult {
  const instanceRef = useRef<JASSUB | null>(null);
  const loadedFontsRef = useRef<Set<string>>(new Set());
  const [active, setActive] = useState(false);
  const [failed, setFailed] = useState(false);

  // 样式对象每次更新都是新引用，用序列化值做依赖键
  const styleKey = JSON.stringify(style);

  // 引擎生命周期与内容更新（创建 / setTrack 统一在防抖回调里处理）
  useEffect(() => {
    if (!videoEl || failed) return;
    let disposed = false;

    const timer = setTimeout(async () => {
      try {
        const assContent = await fetchPreviewAss(
          subtitlePath,
          sampleText,
          style,
        );
        if (disposed) return;
        if (assContent === null) {
          throw new Error('buildPreviewAss failed');
        }

        if (instanceRef.current) {
          // 引擎已就绪：仅更新字幕轨与按需补充字体
          await ensureFontLoaded(style.fontName);
          if (disposed) return;
          instanceRef.current.renderer.setTrack(assContent);
          // 暂停状态下无视频帧回调，手动重绘让样式变更实时生效
          forceRepaint(instanceRef.current, videoEl);
          return;
        }

        // 首次创建：动态 import（避免 SSR/静态导出阶段加载 WASM 模块）
        const { default: JASSUBCtor } = await import('jassub');
        if (disposed) return;

        // 预取所选字体（含主进程 CJK 兜底），失败则依赖 queryFonts: 'local'
        const font = await fetchFontData(style.fontName);
        if (disposed) return;
        const fonts: Uint8Array[] = [];
        let defaultFont: string | undefined;
        if (font) {
          fonts.push(font.data);
          defaultFont = font.fontName;
          loadedFontsRef.current.add(style.fontName.toLowerCase());
        }

        const instance = new JASSUBCtor({
          video: videoEl,
          subContent: assContent,
          fonts,
          ...(defaultFont ? { defaultFont } : {}),
        });
        await instance.ready;
        if (disposed) {
          instance.destroy();
          return;
        }
        instanceRef.current = instance;
        // 调试句柄：便于在 DevTools 里检查预览引擎状态
        (window as unknown as Record<string, unknown>).__jassubPreview =
          instance;
        // 初次挂载视频通常处于暂停态，主动绘制首帧字幕
        forceRepaint(instance, videoEl);
        setActive(true);
      } catch (err) {
        if (disposed) return;
        console.error(
          'JASSUB 预览引擎初始化/更新失败，回退 CSS 模拟预览:',
          err,
        );
        setFailed(true);
        setActive(false);
        if (instanceRef.current) {
          instanceRef.current.destroy();
          instanceRef.current = null;
        }
      }
    }, UPDATE_DEBOUNCE_MS);

    async function ensureFontLoaded(fontName: string) {
      const key = fontName.toLowerCase();
      if (loadedFontsRef.current.has(key) || !instanceRef.current) return;
      const font = await fetchFontData(fontName);
      if (!font || !instanceRef.current) return;
      await instanceRef.current.renderer.addFonts([font.data]);
      instanceRef.current.renderer.setDefaultFont(font.fontName);
      loadedFontsRef.current.add(key);
    }

    return () => {
      disposed = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoEl, subtitlePath, sampleText, styleKey, failed]);

  // 视频元素变化/卸载时销毁引擎实例
  useEffect(() => {
    return () => {
      if (instanceRef.current) {
        instanceRef.current.destroy();
        instanceRef.current = null;
      }
      loadedFontsRef.current.clear();
      setActive(false);
    };
  }, [videoEl]);

  return { active, failed };
}
