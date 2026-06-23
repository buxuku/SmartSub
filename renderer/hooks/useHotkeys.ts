import { useEffect, useRef } from 'react';

export interface HotkeyBinding {
  /** 组合键：'mod+s' / 'shift+mod+z' / 'space' / 'arrowup' / '?' / 'escape' / 'mod+enter' */
  combo: string;
  handler: (e: KeyboardEvent) => void;
  /** 焦点在输入框/文本域/可编辑元素时是否仍生效（默认 false，带修饰键的组合建议开启） */
  allowInInput?: boolean;
  /** 匹配后是否阻止默认行为（默认 true） */
  preventDefault?: boolean;
}

/** mod 键平台适配：macOS 用 Cmd，其余用 Ctrl（供 UI 显示 ⌘/Ctrl 时也用它判断） */
export const isMacPlatform = (): boolean =>
  typeof navigator !== 'undefined' &&
  /mac/i.test(navigator.platform || navigator.userAgent);

const isEditableTarget = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable
  );
};

interface ParsedCombo {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

const parseCombo = (combo: string): ParsedCombo => {
  const parts = combo.toLowerCase().split('+');
  const key = parts[parts.length - 1];
  return {
    key: key === 'space' ? ' ' : key,
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
  };
};

const comboMatches = (
  e: KeyboardEvent,
  p: ParsedCombo,
  isMac: boolean,
): boolean => {
  if (e.key.toLowerCase() !== p.key) return false;
  const modPressed = isMac ? e.metaKey : e.ctrlKey;
  const otherMod = isMac ? e.ctrlKey : e.metaKey;
  if (p.mod !== modPressed) return false;
  if (!p.mod && otherMod) return false;
  // '?' 这类必须借助 shift 才能输入的键，按 e.key 匹配即可，不再校验 shift
  if (p.key !== '?' && p.shift !== e.shiftKey) return false;
  if (p.alt !== e.altKey) return false;
  return true;
};

/**
 * 注册一组快捷键，组件卸载自动清理。
 * 绑定表通过 ref 每次事件时读取，handler 可安全闭包最新 state。
 */
export function useHotkeys(bindings: HotkeyBinding[]): void {
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  useEffect(() => {
    const isMac = isMacPlatform();
    const onKeyDown = (e: KeyboardEvent) => {
      for (const binding of bindingsRef.current) {
        if (!comboMatches(e, parseCombo(binding.combo), isMac)) continue;
        if (!binding.allowInInput && isEditableTarget(e.target)) continue;
        if (binding.preventDefault !== false) e.preventDefault();
        binding.handler(e);
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
