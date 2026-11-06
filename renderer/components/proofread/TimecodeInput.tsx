import React, { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { formatTimecode, parseTimecode } from '../../lib/timecode';

const displayTime = (value: string) => {
  const seconds = parseTimecode(value);
  return seconds === null ? value : formatTimecode(seconds);
};

/** Keep partial edits intact; normalize pasted values and old drafts for display. */
export default function TimecodeInput({
  value,
  onChange,
  ...props
}: Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'onChange'
> & {
  value: string;
  onChange: (value: string) => void;
}) {
  const [text, setText] = useState(() => displayTime(value));
  const emittedValue = useRef(value);
  useEffect(() => {
    if (value !== emittedValue.current) {
      emittedValue.current = value;
      setText(displayTime(value));
    }
  }, [value]);
  return (
    <Input
      {...props}
      type="text"
      className="font-mono tabular-nums"
      placeholder="00:00:00.000"
      spellCheck={false}
      autoComplete="off"
      value={text}
      onChange={(event) => {
        const next = event.target.value;
        emittedValue.current = next;
        setText(next);
        onChange(next);
      }}
      onBlur={(event) => {
        const next = displayTime(text);
        setText(next);
        if (next !== value) {
          emittedValue.current = next;
          onChange(next);
        }
        props.onBlur?.(event);
      }}
    />
  );
}
