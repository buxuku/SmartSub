import React, { useState, useRef } from 'react';

interface TimeRangeEditorLabels {
  invalidFormat: string;
  editHint: string;
}

interface TimeRangeEditorProps {
  /** 行号展示（#id） */
  rowId: string;
  startEndTime: string;
  /** 确认修改；返回错误文案（不应用）或 null（已应用） */
  onCommit: (startSec: number, endSec: number) => string | null;
  labels: TimeRangeEditorLabels;
  /** 时间文本后的附加说明（当前播放/失败标签） */
  suffix?: string;
}

// SRT 时间文本 → 秒；非法返回 null
const parseTimeText = (text: string): number | null => {
  const trimmed = text.trim();
  if (!/^(\d{1,2}:)?\d{1,2}:\d{1,2}([.,]\d{1,3})?$/.test(trimmed)) return null;
  const parts = trimmed.replace(',', '.').split(':');
  let h = 0;
  let m = 0;
  let s = 0;
  if (parts.length === 3) {
    h = parseInt(parts[0], 10);
    m = parseInt(parts[1], 10);
    s = parseFloat(parts[2]);
  } else {
    m = parseInt(parts[0], 10);
    s = parseFloat(parts[1]);
  }
  if (m >= 60 || s >= 60) return null;
  return h * 3600 + m * 60 + s;
};

// 秒 → SRT 时间文本（HH:MM:SS,mmm）
const formatTimeText = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = (seconds % 60).toFixed(3);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.padStart(6, '0').replace('.', ',')}`;
};

/**
 * 展开行时间头的行内编辑器：
 * 点击文本进入编辑态（起/止两个输入框），Enter 确认、Esc 取消、整体失焦确认。
 */
export default function TimeRangeEditor({
  rowId,
  startEndTime,
  onCommit,
  labels,
  suffix,
}: TimeRangeEditorProps) {
  const [editing, setEditing] = useState(false);
  const [startText, setStartText] = useState('');
  const [endText, setEndText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  // Esc 取消时跳过 focusout 触发的提交
  const cancelledRef = useRef(false);

  const beginEdit = () => {
    const times = startEndTime.split(' --> ');
    const startSec = parseTimeText(times[0] || '');
    const endSec = parseTimeText(times[1] || '');
    setStartText(startSec !== null ? formatTimeText(startSec) : times[0] || '');
    setEndText(endSec !== null ? formatTimeText(endSec) : times[1] || '');
    setError(null);
    cancelledRef.current = false;
    setEditing(true);
  };

  const cancelEdit = () => {
    cancelledRef.current = true;
    setEditing(false);
    setError(null);
  };

  const commit = (): void => {
    const startSec = parseTimeText(startText);
    const endSec = parseTimeText(endText);
    if (startSec === null || endSec === null) {
      setError(labels.invalidFormat);
      return;
    }
    const err = onCommit(startSec, endSec);
    if (err) {
      setError(err);
      return;
    }
    setEditing(false);
    setError(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  };

  // 焦点离开整个编辑器时提交（在起/止输入框间移动不触发）
  const handleFocusOut = (e: React.FocusEvent) => {
    if (cancelledRef.current) return;
    if (
      e.relatedTarget &&
      wrapperRef.current?.contains(e.relatedTarget as Node)
    ) {
      return;
    }
    commit();
  };

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-1 min-w-0">
        <button
          type="button"
          className="cursor-text rounded px-0.5 text-left hover:bg-background/60 hover:text-foreground transition-colors"
          title={labels.editHint}
          onClick={(e) => {
            e.stopPropagation();
            beginEdit();
          }}
        >
          #{rowId} · {startEndTime}
        </button>
        {suffix && <span className="truncate">{suffix}</span>}
      </span>
    );
  }

  const inputClass = `h-5 w-[108px] rounded border bg-background px-1 text-[10px] tabular-nums outline-none focus:ring-1 focus:ring-ring ${
    error ? 'border-red-500 focus:ring-red-500' : ''
  }`;

  return (
    <span
      ref={wrapperRef}
      className="inline-flex items-center gap-1"
      onClick={(e) => e.stopPropagation()}
      onBlur={handleFocusOut}
    >
      <span>#{rowId} ·</span>
      <input
        autoFocus
        className={inputClass}
        value={startText}
        onChange={(e) => {
          setStartText(e.target.value);
          setError(null);
        }}
        onKeyDown={handleKeyDown}
        spellCheck={false}
      />
      <span>--&gt;</span>
      <input
        className={inputClass}
        value={endText}
        onChange={(e) => {
          setEndText(e.target.value);
          setError(null);
        }}
        onKeyDown={handleKeyDown}
        spellCheck={false}
      />
      {error && <span className="text-red-500">{error}</span>}
    </span>
  );
}
