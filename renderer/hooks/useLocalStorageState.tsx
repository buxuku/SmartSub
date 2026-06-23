import { useEffect, useRef, useState } from 'react';

export default function useLocalStorageState<
  T extends string | number | boolean | object,
>(
  key: string,
  defaultValue: (() => T) | T,
  validate: (value: unknown) => boolean = () => true,
) {
  const [value, setValue] = useState<T>(defaultValue);
  const inited = useRef(false);
  const skipInitialWrite = useRef(true);

  useEffect(() => {
    const init = () => {
      inited.current = true;
    };

    if (typeof window === 'undefined') return init();

    const str = localStorage.getItem(key);
    if (!str) return init();

    let val: any;
    try {
      val = JSON.parse(str);
    } catch {
      localStorage.removeItem(key);
      return init();
    }

    if (validate(val)) {
      setValue(val);
    } else {
      localStorage.removeItem(key);
    }
    init();
  }, [key]);

  useEffect(() => {
    if (typeof window === 'undefined' || !inited.current) return;
    // 跳过首次 render 的写入，避免用 defaultValue 覆盖已从 localStorage 读出的值
    if (skipInitialWrite.current) {
      skipInitialWrite.current = false;
      return;
    }
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue] as const;
}
